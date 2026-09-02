/**
 * Cross-extension bridge: run the night's capability probe in the sandbox.
 *
 * The probes themselves and their report live in night-mode (`preflight.ts`),
 * which is pure. They are executed here because only spindle can run a command
 * through the same `srt` wrapper a subagent's bash gets: a probe run from the
 * extension host would report an egress, a DNS and a loopback that the children
 * do not have, which is worse than no probe at all.
 *
 * The dependency direction is the usual one: spindle reads night-mode, never
 * the reverse.
 */

import {
	formatPreflightReport,
	nightPreflightProbes,
	PROBE_TIMEOUT_SECONDS,
	preflightPathFor,
	type ProbeOutcome,
	type ProbeSpec,
	runPreflight,
	writePreflightReport,
} from "../../night-mode/preflight.ts";
import { readActiveNightRun } from "../../night-mode/night-run.ts";
import { supervisedSpawn } from "./supervised-spawn.ts";

/** Runs already probed by this process, keyed by run start. One probe per run. */
const probed = new Set<number>();

/** Test seam: forget what has been probed. */
export function resetPreflightState(): void {
	probed.clear();
}

export interface PreflightDeps {
	/** Wrap a command for the OS sandbox; the controller's `wrapCommand`. */
	wrap: (command: string) => Promise<string>;
	/** Session asking, so only the coordinator runs the probe. */
	sessionId?: string | undefined;
	cwd: string;
	now?: Date;
	/** Injected in tests, so the suite never runs `curl` or `ssh`. */
	exec?: (probe: ProbeSpec, command: string, cwd: string) => Promise<ProbeOutcome>;
	write?: (path: string, body: string) => boolean;
}

/**
 * Probe the sandbox once for the active night run and write the report.
 *
 * Returns the path written, or undefined when there is nothing to do: no run,
 * this session is not the run's coordinator, or the run was already probed.
 * Only the coordinator probes, because the answer is a property of the run, not
 * of the process, and a dozen subagents rewriting the same file would race.
 */
export async function runNightPreflight(deps: PreflightDeps): Promise<string | undefined> {
	const run = readActiveNightRun();
	if (!run) return undefined;
	if (!run.sessionId || !deps.sessionId || run.sessionId !== deps.sessionId) return undefined;
	if (probed.has(run.startedAt)) return undefined;
	probed.add(run.startedAt);

	const exec = deps.exec ?? defaultExec;
	const probes = nightPreflightProbes(run.workspacePath ? { workspacePath: run.workspacePath } : {});
	const results = await runPreflight(probes, async (probe) => {
		const command = await deps.wrap(probe.command);
		return exec(probe, command, run.workspacePath ?? deps.cwd);
	});
	const path =
		run.preflightPath ??
		preflightPathFor({ reportPath: run.reportPath, ...(run.workspacePath ? { workspacePath: run.workspacePath } : {}) });
	const body = formatPreflightReport(results, {
		startedAt: deps.now ?? new Date(run.startedAt),
		...(run.workspacePath ? { workspacePath: run.workspacePath } : {}),
	});
	const write = deps.write ?? writePreflightReport;
	return write(path, body) ? path : undefined;
}

/** Run one probe as its own supervised process group, capturing all output. */
const defaultExec = async (_probe: ProbeSpec, command: string, cwd: string): Promise<ProbeOutcome> => {
	let output = "";
	try {
		const { exitCode } = await supervisedSpawn({
			command,
			cwd,
			onData: (data) => {
				output += data.toString("utf-8");
			},
			timeout: PROBE_TIMEOUT_SECONDS,
		});
		return { exitCode, output };
	} catch (error) {
		return { exitCode: null, output: output || String(error) };
	}
};
