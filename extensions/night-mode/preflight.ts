/**
 * What this sandbox actually allows, probed once at the start of the night.
 *
 * The capability envelope of a night run is not stable: on 2026-08-31 a
 * DB-backed Go test suite ran green inside the sandbox, and on 2026-09-01 the
 * same suite could not open a loopback socket (`dial tcp [::1]:5450: operation
 * not permitted`). SSH and raw DNS were denied while HTTPS worked. None of this
 * is visible from configuration: the policy says what was *asked* for, the probe
 * says what the kernel and the proxy actually did.
 *
 * Without it, every night pays for the discovery again, one subagent run at a
 * time: a child concludes "there is no push path", another invents a workaround,
 * and the finding dies with the run. So the results are written to a file inside
 * the run directory, and the path is published in the handshake so the
 * coordinator's prompt and every child's contract can point at it.
 *
 * The probes are commands, not in-process checks, and they are executed by the
 * caller: only the sandboxed shell sees the real envelope, and a check run from
 * the extension host would cheerfully report an egress the children do not have.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentWorkspacesRoot } from "./agent-workspace.ts";
import { formatDateTimeStamp } from "./config.ts";

/** Output of a probe command, as the caller's shell reports it. */
export interface ProbeOutcome {
	exitCode: number | null;
	output: string;
}

export interface ProbeSpec {
	id: string;
	/** What a reader of the report is being told. */
	label: string;
	/** Shell command line, run through the same wrapper a subagent's bash gets. */
	command: string;
	/** Why the answer matters, one line, printed next to the result. */
	meaning: string;
	/** Defaults to "exit code 0". */
	okWhen?: (outcome: ProbeOutcome) => boolean;
}

export interface ProbeResult {
	id: string;
	label: string;
	meaning: string;
	ok: boolean;
	exitCode: number | null;
	/** First meaningful line of output, trimmed for the report. */
	detail: string;
}

/** Seconds any single probe may take before it is treated as a failure. */
export const PROBE_TIMEOUT_SECONDS = 20;

/** How much of a probe's output is kept in the report. */
const MAX_DETAIL = 200;

/**
 * Loopback TCP is probed with node rather than `nc`: the run always has node
 * (pi runs on it), and the interesting question is whether a *connect* to a
 * listener this process just opened is permitted, which `nc -z` against an
 * arbitrary port cannot answer.
 */
const LOOPBACK_PROBE =
	"node -e 'const net=require(\"net\");" +
	"const s=net.createServer(c=>c.end());" +
	"s.on(\"error\",e=>{process.stdout.write(\"listen failed: \"+e.message);process.exit(1)});" +
	"s.listen(0,\"127.0.0.1\",()=>{const p=s.address().port;" +
	"const c=net.connect(p,\"127.0.0.1\",()=>{process.stdout.write(\"connected to 127.0.0.1:\"+p);c.end();s.close()});" +
	"c.on(\"error\",e=>{process.stdout.write(\"connect failed: \"+e.message);process.exit(1)})})'";

/**
 * The probe list. Deliberately short and fixed: these are the six answers a
 * night run has needed to know before it can plan, and a probe suite that grows
 * without limit is a second thing to maintain at 2am.
 */
export function nightPreflightProbes(input: { workspacePath?: string } = {}): ProbeSpec[] {
	const probes: ProbeSpec[] = [
		{
			id: "https-egress",
			label: "HTTPS egress (api.github.com)",
			meaning: "no HTTPS means no `gh`, no PR, no clone over https",
			command: "curl -sS -o /dev/null -m 15 -w '%{http_code}' https://api.github.com",
			// curl exits 0 on any HTTP response; a blocked CONNECT prints 000.
			okWhen: ({ exitCode, output }) => exitCode === 0 && /\b[1-5]\d\d\b/.test(output) && !output.includes("000"),
		},
		{
			id: "raw-dns",
			label: "raw DNS (github.com)",
			meaning: "without it every non-HTTP client (ssh, psql, a Go test dialling a host) fails to resolve",
			command: "nslookup github.com 2>&1 || host github.com 2>&1",
		},
		{
			id: "ssh-github",
			label: "SSH to github.com",
			meaning: "when this fails, an inherited `git@github.com:` remote cannot push and must be HTTPS",
			command: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -T git@github.com 2>&1",
			// GitHub's SSH endpoint greets and exits 1 on success, so the text decides.
			okWhen: ({ output }) => /successfully authenticated/i.test(output),
		},
		{
			id: "gh-auth",
			label: "gh auth status",
			meaning: "the credential the HTTPS push path and every PR call depend on",
			command: "gh auth status 2>&1",
		},
		{
			id: "loopback-tcp",
			label: "loopback TCP",
			meaning: "no loopback means no local database, no test container, no DB-backed test suite",
			command: LOOPBACK_PROBE,
		},
	];
	if (input.workspacePath) {
		probes.push({
			id: "jj-workspace",
			label: "jj in the night working copy",
			meaning: "a failure here is the `XDG_CONFIG_HOME` redirect not reaching this shell; nobody can commit",
			command: `jj --ignore-working-copy -R ${shellQuote(input.workspacePath)} status 2>&1`,
		});
	}
	return probes;
}

/** Single-quote a path for a shell command line. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Run every probe through `exec` and classify the outcome. Never throws: a
 * probe that blows up is a failed probe, and the report says so.
 */
export async function runPreflight(
	probes: ProbeSpec[],
	exec: (probe: ProbeSpec) => Promise<ProbeOutcome>,
): Promise<ProbeResult[]> {
	const results: ProbeResult[] = [];
	for (const probe of probes) {
		let outcome: ProbeOutcome;
		try {
			outcome = await exec(probe);
		} catch (error) {
			outcome = { exitCode: null, output: String(error) };
		}
		const ok = probe.okWhen ? probe.okWhen(outcome) : outcome.exitCode === 0;
		results.push({
			id: probe.id,
			label: probe.label,
			meaning: probe.meaning,
			ok,
			exitCode: outcome.exitCode,
			detail: firstLine(outcome.output),
		});
	}
	return results;
}

function firstLine(output: string): string {
	const line = output
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0);
	if (!line) return "(no output)";
	return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL)}...` : line;
}

/**
 * The report, as markdown. Written for a subagent that has one question ("can I
 * do X tonight?"), so every line carries the answer and what it rules out.
 */
export function formatPreflightReport(
	results: ProbeResult[],
	input: { startedAt: Date; workspacePath?: string },
): string {
	const lines = [
		`# Night sandbox capability probe - ${formatDateTimeStamp(input.startedAt)}`,
		"",
		"Measured inside the run's own sandboxed shell, so this is what a subagent sees, not what the policy asked " +
			"for. Trust it over your assumptions, and over last night's.",
		"",
		...(input.workspacePath ? [`Working copy: \`${input.workspacePath}\``, ""] : []),
		"| Capability | Result | Detail |",
		"| --- | --- | --- |",
		...results.map(
			(result) =>
				`| ${result.label} | ${result.ok ? "yes" : "NO"} | ${escapeCell(result.detail)} (exit ${result.exitCode ?? "n/a"}) |`,
		),
		"",
		"## What each answer rules out",
		"",
		...results.map((result) => `- **${result.label}**: ${result.ok ? "available" : "unavailable"} - ${result.meaning}`),
		"",
		"Not probed: one read call per configured MCP server. See the night-mode README.",
		"",
	];
	return `${lines.join("\n")}`;
}

function escapeCell(value: string): string {
	return value.replaceAll("|", "\\|");
}

/**
 * Where the report goes: beside the per-subagent workspaces, which is already
 * in the run's writable set and readable by every child. Falls back to the
 * report's own directory for a run with no clone.
 */
export function preflightPathFor(input: { workspacePath?: string; reportPath: string }): string {
	const dir = input.workspacePath ? agentWorkspacesRoot(input.workspacePath) : dirname(input.reportPath);
	return join(dir, "sandbox-capabilities.md");
}

/** Write the report. Returns false when it could not be written. */
export function writePreflightReport(path: string, body: string): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, body, "utf-8");
		return true;
	} catch {
		return false;
	}
}
