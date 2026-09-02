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
	type AgentWaitResult,
	type HerdrTab,
	type PaneAgentState,
	findAgentStatus,
	isAgentBlockedError,
	isPaneBusyError,
	isPromptStalledError,
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
	 * Any non-busy error is fatal. On timeout it returns an explicit error naming
	 * the pane and the last herdr error.
	 */
	async startAgent(
		name: string,
		kind: string,
		paneId: string,
		childArgs: string[],
		timeoutMs = 60000,
		opts?: { readyTimeoutMs?: number; pollMs?: number; signal?: AbortSignal },
	): Promise<{ ok: boolean; error?: string }> {
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
			// Any non-busy error is fatal (bad name, unsupported kind, pane gone, ...).
			if (!isPaneBusyError(res.error)) return { ok: false, error: res.error };
			lastBusy = res.error;
			const remaining = deadline - Date.now();
			if (remaining <= 0 || opts?.signal?.aborted) {
				return {
					ok: false,
					error: `pane ${paneId} did not become ready to start an agent within ${readyTimeoutMs}ms (last herdr error: ${lastBusy ?? "agent_pane_busy"})`,
				};
			}
			await delay(Math.min(pollMs, remaining), opts?.signal);
		}
	}

	/**
	 * Submit a prompt to a live agent via `herdr agent prompt`. Uses bracketed
	 * paste, so multi-line text is delivered as one clean user message. `target`
	 * is a live agent name or the pane id hosting it.
	 *
	 * Submission is confirmed, not assumed: a bare `agent prompt` exits 0 as soon
	 * as the text is sent, and when pi is still binding its input the trailing
	 * submit key is swallowed as a newline — the task then sits in the composer
	 * forever and the run dies at its timeout with no output. So we pass `--wait
	 * --until working --until done`, which makes herdr report
	 * `agent_prompt_stalled` when no state change follows the submission, and
	 * repair that by replaying ONLY the submit key (re-sending the prompt would
	 * duplicate the text that is already in the composer).
	 *
	 * A `--wait` timeout is NOT a stall: herdr only starts that wait after it has
	 * observed a state change, so the input was accepted and the turn may already
	 * have completed. Those resolve `ok` and let the completion machinery decide.
	 * Returns after submission; completion is awaited separately by the caller.
	 */
	async promptAgent(
		target: string,
		text: string,
		opts?: { waitMs?: number; retries?: number; signal?: AbortSignal },
	): Promise<{ ok: boolean; error?: string }> {
		const waitMs = opts?.waitMs ?? 15000;
		const retries = opts?.retries ?? 2;
		const res = await this.#transport.run(
			[
				"agent",
				"prompt",
				target,
				text,
				"--wait",
				"--until",
				"working",
				"--until",
				"done",
				"--timeout",
				String(waitMs),
			],
			waitMs + 5000,
			opts?.signal,
		);
		if (res.ok) return { ok: true };
		// Blocked: herdr never sent the text, so there is nothing to replay.
		if (isAgentBlockedError(res.error)) return { ok: false, error: res.error };
		// Accepted-but-unmatched (deadline hit after a state change): treat as sent.
		if (isTimeoutError(res.error)) return { ok: true };
		if (!isPromptStalledError(res.error)) return { ok: false, error: res.error };

		let lastError = res.error;
		for (let attempt = 0; attempt < retries && !opts?.signal?.aborted; attempt++) {
			const state = await this.getPaneAgentState(target);
			if (!state.exists) return { ok: false, error: `pane ${target} is gone` };
			// The turn may have started between the stall report and this probe.
			if (state.status === "working" || state.status === "done") return { ok: true };
			await this.sendKeys(target, ["Enter"]);
			const waited = await this.waitAgentStatus(target, ["working", "done"], waitMs, opts?.signal);
			if (waited.kind === "reached") return { ok: true };
			if (waited.kind === "gone") return { ok: false, error: `pane ${target} is gone` };
			lastError = `the agent stayed idle after the submit key was replayed (${waited.kind})`;
		}
		return {
			ok: false,
			error: `the task was delivered to ${target} but no turn started after ${retries} submit retries (last herdr state: ${lastError ?? "agent_prompt_stalled"})`,
		};
	}

	/**
	 * Send raw key presses to an agent pane, e.g. replaying the submit key when a
	 * prompt landed in the composer without starting a turn. Best-effort.
	 */
	async sendKeys(target: string, keys: string[]): Promise<void> {
		await this.#transport.run(["agent", "send-keys", target, ...keys]);
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
