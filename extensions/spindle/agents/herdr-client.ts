/**
 * herdr integration: a typed client over the `herdr` CLI.
 *
 * `HerdrClient` holds a `HerdrTransport` (how commands run) and turns each herdr
 * operation into typed args + a parsed result, keeping the rest of the code
 * API-name-agnostic. Arg construction, the `agent start` busy-retry loop, and
 * the herdr-version-specific `agent wait` all live here; parsing delegates to
 * `herdr-parse.ts`. The default `herdr` export is bound to the production
 * transport; tests construct `new HerdrClient(fakeTransport)`.
 */

import { type StatusProbe } from "./pane-lifecycle.ts";
import {
	type AgentStatus,
	isAgentStartupTimeoutError,
	type AgentWaitResult,
	type HerdrTab,
	type PaneAgentState,
	findAgentStatus,
	isPaneBusyError,
	isTimeoutError,
	lastJsonLine,
	parsePaneId,
	parseTab,
	parseTabs,
} from "./herdr-parse.ts";
import { execFileTransport, type HerdrTransport } from "./herdr-transport.ts";

/** Resolve after `ms`, or immediately if `signal` is/gets aborted. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

export type SplitDirection = "right" | "down";

/**
 * How long herdr may block waiting for a started agent to look
 * interactive-ready. Short on purpose: the wait is pure latency for a subagent
 * that starts working the moment it launches, and the caller verifies the child
 * itself afterwards.
 */
export const AGENT_STARTUP_TIMEOUT_MS = 15_000;

/** Why a `herdr agent start` failed, so callers can tell recoverable apart. */
export type StartAgentFailure = "startup-timeout" | "pane-busy" | "fatal";

export interface StartAgentResult {
	ok: boolean;
	failure?: StartAgentFailure;
	error?: string;
}

export class HerdrClient {
	readonly #transport: HerdrTransport;

	constructor(transport: HerdrTransport = execFileTransport) {
		this.#transport = transport;
	}

	async listTabs(workspaceId?: string): Promise<HerdrTab[]> {
		const args = ["tab", "list"];
		if (workspaceId) args.push("--workspace", workspaceId);
		const res = await this.#transport.run(args);
		return res.ok ? parseTabs(res.result) : [];
	}

	async createTab(label: string, workspaceId?: string, cwd?: string): Promise<HerdrTab | undefined> {
		const args = ["tab", "create", "--label", label, "--no-focus"];
		if (workspaceId) args.push("--workspace", workspaceId);
		// The tab's root pane is reused as the first run's pane, and `agent start`
		// cannot set a directory, so the first run's cwd has to be decided here.
		if (cwd) args.push("--cwd", cwd);
		const res = await this.#transport.run(args);
		return res.ok ? parseTab(res.result) : undefined;
	}

	/** Close a whole tab (and all of its panes) by id. Best-effort. */
	async closeTab(tabId: string): Promise<void> {
		await this.#transport.run(["tab", "close", tabId]);
	}

	/**
	 * Split an existing pane and return the new pane's id. `direction` is "right"
	 * (new pane to the right) or "down" (new pane below). `ratio` is the fraction
	 * of space the EXISTING pane keeps (the new pane gets `1 - ratio`). Used to
	 * build an evenly-sized grid of panes.
	 */
	async splitPane(
		paneId: string,
		direction: SplitDirection,
		ratio: number,
		cwd?: string,
	): Promise<{ ok: boolean; paneId?: string; error?: string }> {
		const args = ["pane", "split", paneId, "--direction", direction, "--ratio", ratio.toFixed(4), "--no-focus"];
		if (cwd) args.push("--cwd", cwd);
		const res = await this.#transport.run(args);
		if (!res.ok) return { ok: false, error: res.error };
		return { ok: true, paneId: parsePaneId(res.result) };
	}

	/** Set a pane's display label. Best-effort. */
	async renamePane(paneId: string, label: string): Promise<void> {
		await this.#transport.run(["pane", "rename", paneId, label]);
	}

	/**
	 * Start a supported interactive agent in an existing (idle shell) pane via
	 * `herdr agent start`. The pane must be at its interactive shell prompt with
	 * nothing running, or herdr reports `agent_pane_busy`. A freshly split pane's
	 * shell can still be initializing (or briefly busy), so this polls `agent
	 * start` every `pollMs` until it takes, up to `readyTimeoutMs` (default 30s).
	 *
	 * `timeoutMs` is herdr's own startup deadline, not the child's lifetime, and
	 * it is deliberately short ({@link AGENT_STARTUP_TIMEOUT_MS}): herdr blocks
	 * for all of it waiting for the started agent to look interactive-ready,
	 * which a subagent that picks up its task immediately never does. Waiting
	 * longer only delays the caller, so we take the timeout early and let it
	 * verify the child directly.
	 *
	 * A failure is classified rather than flattened: `startup-timeout` is herdr's
	 * readiness probe giving up (the child may well be running), `pane-busy` is a
	 * pane that never freed up, `fatal` is everything else (bad name, unsupported
	 * kind, pane gone).
	 */
	async startAgent(
		name: string,
		kind: string,
		paneId: string,
		childArgs: string[],
		timeoutMs = AGENT_STARTUP_TIMEOUT_MS,
		opts?: { readyTimeoutMs?: number; pollMs?: number; signal?: AbortSignal },
	): Promise<StartAgentResult> {
		const args = [
			"agent",
			"start",
			name,
			"--kind",
			kind,
			"--pane",
			paneId,
			"--timeout",
			String(timeoutMs),
			"--",
			...childArgs,
		];
		const readyTimeoutMs = opts?.readyTimeoutMs ?? 30000;
		const pollMs = opts?.pollMs ?? 250;
		const deadline = Date.now() + readyTimeoutMs;
		let lastBusy: string | undefined;
		for (;;) {
			const res = await this.#transport.run(args, timeoutMs + 5000, opts?.signal);
			if (res.ok) return { ok: true };
			// Startup timeout: the launch command was accepted and pi was spawned;
			// only herdr's readiness probe expired. Retrying would start a second
			// child in the same pane, so report it and let the caller check liveness.
			if (isAgentStartupTimeoutError(res.error)) {
				return { ok: false, failure: "startup-timeout", error: res.error ?? "timed out waiting for agent startup" };
			}
			// Any non-busy error is fatal (bad name, unsupported kind, pane gone, ...).
			if (!isPaneBusyError(res.error)) return { ok: false, failure: "fatal", error: res.error };
			lastBusy = res.error;
			const remaining = deadline - Date.now();
			if (remaining <= 0 || opts?.signal?.aborted) {
				return {
					ok: false,
					failure: "pane-busy",
					error: `pane ${paneId} did not become ready to start an agent within ${readyTimeoutMs}ms (last herdr error: ${lastBusy ?? "agent_pane_busy"})`,
				};
			}
			await delay(Math.min(pollMs, remaining), opts?.signal);
		}
	}

	/**
	 * Probe a pane's agent status. A `pane_not_found` error means the pane is gone
	 * (terminated); any other CLI error is treated as transient so callers keep
	 * waiting rather than declaring a live run dead.
	 */
	async getPaneAgentState(paneId: string): Promise<PaneAgentState> {
		const res = await this.#transport.run(["pane", "get", paneId]);
		if (!res.ok) {
			const gone = /not[_ ]?found/i.test(res.error ?? "");
			return { exists: !gone };
		}
		return { exists: true, status: findAgentStatus(res.result) };
	}

	/**
	 * Block (via `herdr agent wait`) until a pane's agent reaches any of
	 * `statuses`. herdr 0.7.5 replaced the old top-level `wait agent-status` with
	 * `agent wait <target>`, where the target is a unique live agent name or the
	 * pane id hosting it, and repeated `--until` flags resolve on the first
	 * matching state. Returns which status was reached, `timeout` (deadline hit,
	 * pane alive), `not_running` (no agent detected yet, e.g. still starting), or
	 * `gone` (wait aborted).
	 */
	async waitAgentStatus(
		paneId: string,
		statuses: AgentStatus[],
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentWaitResult> {
		const args = ["agent", "wait", paneId];
		for (const s of statuses) args.push("--until", s);
		args.push("--timeout", String(timeoutMs));
		const res = await this.#transport.run(args, timeoutMs + 5000, signal);
		if (res.ok) return { kind: "reached", status: findAgentStatus(lastJsonLine(res.stdout)) ?? statuses[0] };
		const err = res.error ?? "";
		if (isTimeoutError(err)) return { kind: "timeout" };
		// `agent_not_running` means no detected agent yet (startup) or its agent
		// exited. The pane itself may still be alive, so callers must re-check pane
		// existence before declaring the run dead.
		if (/agent[_ ]?not[_ ]?running|not[_ ]?found/i.test(err)) return { kind: "not_running" };
		return { kind: "gone" };
	}

	/**
	 * Production `StatusProbe` (see pane-lifecycle.ts) bound to a herdr pane: the
	 * blocking wait maps to `herdr agent wait`, the point probe to `pane get`.
	 * Keeps the lifecycle machine free of any herdr/pane-id knowledge.
	 */
	statusProbe(paneId: string): StatusProbe {
		return {
			waitUntil: (statuses, timeoutMs, signal) => this.waitAgentStatus(paneId, statuses, timeoutMs, signal),
			peek: () => this.getPaneAgentState(paneId),
		};
	}

	/** Read recent pane output as a fallback when the output file is missing. */
	async readPane(paneId: string, lines = 200): Promise<string | undefined> {
		const res = await this.#transport.run([
			"pane",
			"read",
			paneId,
			"--source",
			"recent-unwrapped",
			"--lines",
			String(lines),
			"--format",
			"text",
		]);
		if (!res.ok || !res.result) return undefined;
		const text = res.result.text ?? res.result.output ?? res.result.content;
		return typeof text === "string" ? text : undefined;
	}
}

/** Default client bound to the production (execFile) transport. */
export const herdr = new HerdrClient();
