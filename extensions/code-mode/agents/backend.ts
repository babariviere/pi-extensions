/**
 * The run-backend seam and its launcher.
 *
 * Two adapters implement `RunBackend` (see run.ts): `headless` (child `pi`
 * processes) and `herdr` (live panes). This module is the one place that
 * knows both exist: it picks the adapter for a batch and contains CLI drift.
 * The herdr adapter speaks a specific herdr dialect (`pane run`, `agent wait`);
 * when the installed binary no longer does, the launcher
 * probes once, caches the verdict, and falls back to the headless adapter
 * instead of failing every run with a raw CLI error.
 */

import { runHeadlessBatch } from "./headless.ts";
import { execFileTransport, isInHerdr, type HerdrTransport } from "./herdr-transport.ts";
import { runInHerdr } from "./herdr-backend.ts";
import { type RunBackend, type RunContext, type RunRequest, type RunResult } from "./run.ts";

/**
 * How many children herdr may fail to launch, in a row, before the launcher
 * stops choosing it. Two is enough to tell a broken runner from one bad pane,
 * and cheap to be wrong about: the headless adapter runs the same children.
 */
export const LAUNCH_FAILURE_LIMIT = 2;

/** The installed herdr's verdict on the dialect the adapter speaks. */
export interface HerdrDialect {
	/** True when herdr accepts the flags/subcommands the adapter passes. */
	compatible: boolean;
	/** What is missing; surfaced with the headless fallback. */
	reason?: string;
}

/**
 * Probe the installed herdr for the dialect `herdr-backend.ts` speaks:
 * `pane run` starts Pi atomically and `agent wait` observes the detected Pi
 * process. Read-only (`--help` runs), cheap, and never throws: any transport
 * failure is an incompatible verdict with a reason, so a missing or broken
 * binary degrades to headless rather than breaking `agents.run`.
 */
export async function probeHerdrDialect(transport: HerdrTransport = execFileTransport): Promise<HerdrDialect> {
	const pane = await transport.run(["pane", "--help"]);
	if (!pane.ok) return { compatible: false, reason: `herdr pane unavailable (${pane.error ?? "no help output"})` };
	if (!/\brun\b/.test(pane.stdout ?? "")) return { compatible: false, reason: "herdr pane run is missing" };
	const agent = await transport.run(["agent", "--help"]);
	if (!/\bwait\b/.test(agent.stdout ?? "")) return { compatible: false, reason: "herdr agent wait is missing" };
	return { compatible: true };
}

/** What the launcher decided, and why. */
export interface BackendSelection {
	backend: "herdr" | "headless";
	/** Why a herdr session fell back to headless. Undefined when herdr is used. */
	degradedReason?: string;
}

export interface RunLauncherDeps {
	/** Herdr dialect probe; defaults to `probeHerdrDialect` on the default transport. */
	probe?: () => Promise<HerdrDialect>;
	/** Environment check; defaults to `isInHerdr()`. */
	inHerdr?: () => boolean;
	herdr?: RunBackend;
	headless?: RunBackend;
}

/**
 * The launcher: the deep module behind the run-backend seam. `run()` keeps
 * the `RunBackend` interface, so callers cannot tell selection from
 * execution; the dialect probe (at most one round-trip per launcher) and the
 * fallback live here. A degraded herdr session still runs every batch, via
 * the headless adapter, with the reason on `selection()` for the caller to
 * surface.
 */
export class RunLauncher {
	readonly #deps: RunLauncherDeps;
	#selection: Promise<BackendSelection> | undefined;
	/** Consecutive launch-class failures on the herdr adapter. */
	#launchFailures = 0;
	#lastLaunchError: string | undefined;

	constructor(deps: RunLauncherDeps = {}) {
		this.#deps = deps;
	}

	/** The adapter a batch will use. Probes the herdr dialect at most once. */
	selection(): Promise<BackendSelection> {
		this.#selection ??= this.#resolve();
		return this.#selection;
	}

	/** Run a batch through the selected adapter, then judge the adapter by it. */
	async run(requests: RunRequest[], context: RunContext): Promise<RunResult[]> {
		const selection = await this.selection();
		const backend =
			selection.backend === "herdr" ? (this.#deps.herdr ?? runInHerdr) : (this.#deps.headless ?? runHeadlessBatch);
		const results = await backend(requests, context);
		if (selection.backend === "herdr") this.#judgeHerdr(results);
		return results;
	}

	/**
	 * Demote a herdr session that has stopped launching children.
	 *
	 * The dialect probe only catches a herdr that no longer speaks the adapter's
	 * CLI. It cannot catch a herdr that accepts every command and still never
	 * produces a usable child, which is what happened on 2026-09-02: the selection
	 * was made once at 20:48 and every batch for the next ten hours went to the
	 * same broken adapter, while the headless one — no panes, no readiness probe,
	 * a child process it waits on — sat unused.
	 *
	 * So the decision is revisited from evidence: `LAUNCH_FAILURE_LIMIT`
	 * consecutive launch-class failures (see `RunFailure`) replace the cached
	 * selection with headless, reason included, for the rest of the process. Only
	 * `launch` counts — a child that ran and failed says nothing about the adapter
	 * — and any run that got launched clears the streak.
	 */
	#judgeHerdr(results: RunResult[]): void {
		for (const result of results) {
			if (result.failure === "launch") {
				this.#launchFailures++;
				this.#lastLaunchError = result.error;
			} else {
				this.#launchFailures = 0;
			}
		}
		if (this.#launchFailures < LAUNCH_FAILURE_LIMIT) return;
		this.#selection = Promise.resolve({
			backend: "headless",
			degradedReason: `herdr failed to launch ${this.#launchFailures} children in a row (${
				this.#lastLaunchError ?? "no reason reported"
			})`,
		});
	}

	async #resolve(): Promise<BackendSelection> {
		if (!(this.#deps.inHerdr?.() ?? isInHerdr())) return { backend: "headless" };
		const dialect = await (this.#deps.probe?.() ?? probeHerdrDialect());
		if (dialect.compatible) return { backend: "herdr" };
		return { backend: "headless", degradedReason: dialect.reason ?? "herdr CLI incompatible" };
	}
}
