/**
 * The run-backend seam and its launcher.
 *
 * Two adapters implement `RunBackend` (see run.ts): `headless` (child `pi`
 * processes) and `herdr` (live panes). This module is the one place that
 * knows both exist: it picks the adapter for a batch and contains CLI drift.
 * The herdr adapter speaks a specific herdr dialect (`agent start --kind`,
 * `agent wait`); when the installed binary no longer does, the launcher
 * probes once, caches the verdict, and falls back to the headless adapter
 * instead of failing every run with a raw CLI error.
 */

import { runHeadlessBatch } from "./headless.ts";
import { execFileTransport, isInHerdr, type HerdrTransport } from "./herdr-transport.ts";
import { runInHerdr } from "./herdr-backend.ts";
import { type RunBackend, type RunContext, type RunRequest, type RunResult } from "./run.ts";

/** The installed herdr's verdict on the dialect the adapter speaks. */
export interface HerdrDialect {
	/** True when herdr accepts the flags/subcommands the adapter passes. */
	compatible: boolean;
	/** What is missing; surfaced with the headless fallback. */
	reason?: string;
}

/**
 * Probe the installed herdr for the dialect `herdr-backend.ts` speaks:
 * `agent start` must accept `--kind`, and `agent` must have the `wait`
 * subcommand herdr 0.7.5 introduced. Read-only (`--help` runs), cheap, and
 * never throws: any transport failure is an incompatible verdict with a
 * reason, so a missing or broken binary degrades to headless rather than
 * breaking `agents.run`.
 */
export async function probeHerdrDialect(
	transport: HerdrTransport = execFileTransport,
): Promise<HerdrDialect> {
	const start = await transport.run(["agent", "start", "--help"]);
	if (!start.ok) {
		return {
			compatible: false,
			reason: `herdr agent start unavailable (${start.error ?? "no help output"})`,
		};
	}
	if (!/--kind/.test(start.stdout ?? "")) {
		return { compatible: false, reason: "herdr agent start does not accept --kind" };
	}
	const agent = await transport.run(["agent", "--help"]);
	if (!/\bwait\b/.test(agent.stdout ?? "")) {
		return { compatible: false, reason: "herdr agent wait is missing" };
	}
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

	constructor(deps: RunLauncherDeps = {}) {
		this.#deps = deps;
	}

	/** The adapter a batch will use. Probes the herdr dialect at most once. */
	selection(): Promise<BackendSelection> {
		this.#selection ??= this.#resolve();
		return this.#selection;
	}

	/** Run a batch through the selected adapter. */
	async run(requests: RunRequest[], context: RunContext): Promise<RunResult[]> {
		const selection = await this.selection();
		const backend =
			selection.backend === "herdr"
				? (this.#deps.herdr ?? runInHerdr)
				: (this.#deps.headless ?? runHeadlessBatch);
		return backend(requests, context);
	}

	async #resolve(): Promise<BackendSelection> {
		if (!(this.#deps.inHerdr?.() ?? isInHerdr())) return { backend: "headless" };
		const dialect = await (this.#deps.probe?.() ?? probeHerdrDialect());
		if (dialect.compatible) return { backend: "herdr" };
		return { backend: "headless", degradedReason: dialect.reason ?? "herdr CLI incompatible" };
	}
}
