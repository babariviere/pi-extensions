/**
 * herdr integration: detection + a thin typed wrapper over the `herdr` CLI.
 *
 * The CLI prints a single JSON-RPC-shaped line to stdout, e.g.
 *   {"id":"cli:tab:list","result":{"tabs":[...],"type":"tab_list"}}
 * We shell out and parse that JSON. All method names live behind the wrappers
 * below so the rest of the code stays API-name-agnostic. The pure parse helpers
 * are exported for unit testing without a live herdr server.
 */

import { execFile } from "node:child_process";
import { type StatusProbe } from "./pane-lifecycle.ts";

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

/**
 * True when a `herdr agent start` error means the target pane is not (yet) ready
 * to host an agent: it still has a foreground process (an initializing shell, or
 * a leftover/sibling agent). herdr reports this as `agent_pane_busy` / "not an
 * available shell". Such a pane is expected to become ready shortly, so callers
 * retry rather than failing the run outright.
 */
export function isPaneBusyError(error: string | undefined): boolean {
	return /agent[_ ]?pane[_ ]?busy|not an available shell/i.test(error ?? "");
}

export function isInHerdr(): boolean {
	return process.env.HERDR_ENV === "1" && !!process.env.HERDR_SOCKET_PATH;
}

export function currentWorkspaceId(): string | undefined {
	return process.env.HERDR_WORKSPACE_ID || undefined;
}

export interface HerdrCliResult {
	ok: boolean;
	result?: Record<string, unknown>;
	error?: string;
	stdout?: string;
}

/** Run a `herdr` CLI command and parse its JSON stdout. Never throws. */
export function runHerdr(args: string[], timeoutMs = 10000, signal?: AbortSignal): Promise<HerdrCliResult> {
	return new Promise((resolve) => {
		execFile("herdr", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal }, (err, stdout, stderr) => {
			const text = (stdout || "").trim();
			const parsed = parseHerdrJson(text);
			if (parsed) {
				resolve({ ...parsed, stdout: text });
				return;
			}
			if (err) {
				resolve({ ok: false, error: (stderr || err.message || "herdr command failed").trim(), stdout: text });
				return;
			}
			// Clean exit with no JSON payload: some herdr commands (e.g. `pane run`)
			// succeed silently. Treat exit 0 as success with an empty result; callers
			// that need a parsed value already handle an empty result as undefined.
			resolve({ ok: true, result: {}, stdout: text });
		});
	});
}

/**
 * Parse a herdr CLI JSON response. Tolerates leading log lines by scanning for
 * the last JSON object line. Returns undefined when no JSON is present.
 */
export function parseHerdrJson(stdout: string): HerdrCliResult | undefined {
	if (!stdout) return undefined;
	const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line.startsWith("{")) continue;
		try {
			const msg = JSON.parse(line) as { result?: Record<string, unknown>; error?: unknown };
			if (msg.error) {
				const message = typeof msg.error === "object" && msg.error && "message" in msg.error
					? String((msg.error as { message?: unknown }).message ?? "herdr error")
					: String(msg.error);
				return { ok: false, error: message };
			}
			return { ok: true, result: msg.result ?? {} };
		} catch {
			// Not JSON; keep scanning earlier lines.
		}
	}
	return undefined;
}

export interface HerdrTab {
	tabId: string;
	label?: string;
	workspaceId?: string;
	/** The pane herdr always creates alongside a new tab (empty shell). */
	rootPaneId?: string;
}

/**
 * Build a readable pane title from the agent name plus a short task slug, so a
 * watcher can tell panes apart. Newlines/control chars are stripped and the
 * slug is clamped. Falls back to the bare agent name when the task is empty.
 */
export function paneLabel(agentName: string, task: string, maxTaskLen = 50): string {
	const slug = task
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!slug) return agentName;
	const clamped = slug.length > maxTaskLen ? `${slug.slice(0, maxTaskLen).trimEnd()}\u2026` : slug;
	return `${agentName} \u00b7 ${clamped}`;
}

/** Tolerant parse of a `herdr tab list` result. */
export function parseTabs(result: Record<string, unknown> | undefined): HerdrTab[] {
	if (!result) return [];
	const arr = Array.isArray(result.tabs) ? result.tabs : [];
	const out: HerdrTab[] = [];
	for (const raw of arr as unknown[]) {
		if (!raw || typeof raw !== "object") continue;
		const o = raw as Record<string, unknown>;
		const tabId = o.tab_id ?? o.tabId ?? o.id;
		if (typeof tabId !== "string") continue;
		out.push({
			tabId,
			label: typeof o.label === "string" ? o.label : undefined,
			workspaceId: typeof o.workspace_id === "string" ? o.workspace_id : typeof o.workspaceId === "string" ? o.workspaceId : undefined,
		});
	}
	return out;
}

/**
 * Extract a single tab object. Handles both `tab get` (flat) and `tab create`
 * (`{tab:{...}, root_pane:{...}}`), capturing the empty root pane id so callers
 * can close it (a fresh tab always ships with one empty shell pane).
 */
export function parseTab(result: Record<string, unknown> | undefined): HerdrTab | undefined {
	if (!result) return undefined;
	const rootPaneId = parsePaneId(
		result.root_pane && typeof result.root_pane === "object" ? (result.root_pane as Record<string, unknown>) : undefined,
	);
	const direct = result.tab_id ?? result.tabId ?? result.id;
	if (typeof direct === "string") {
		return {
			tabId: direct,
			label: typeof result.label === "string" ? result.label : undefined,
			workspaceId: typeof result.workspace_id === "string" ? result.workspace_id : undefined,
			rootPaneId,
		};
	}
	const nested = result.tab;
	if (nested && typeof nested === "object") {
		const tab = parseTab(nested as Record<string, unknown>);
		if (tab && !tab.rootPaneId && rootPaneId) tab.rootPaneId = rootPaneId;
		return tab;
	}
	return undefined;
}

/** Extract a pane id from an `agent start` / `pane split` result. */
export function parsePaneId(result: Record<string, unknown> | undefined): string | undefined {
	if (!result) return undefined;
	const direct = result.pane_id ?? result.paneId;
	if (typeof direct === "string") return direct;
	for (const key of ["pane", "agent", "terminal"]) {
		const nested = result[key];
		if (nested && typeof nested === "object") {
			const id = parsePaneId(nested as Record<string, unknown>);
			if (id) return id;
		}
	}
	return undefined;
}

// --- typed method wrappers ---------------------------------------------------

export async function listTabs(workspaceId?: string): Promise<HerdrTab[]> {
	const args = ["tab", "list"];
	if (workspaceId) args.push("--workspace", workspaceId);
	const res = await runHerdr(args);
	return res.ok ? parseTabs(res.result) : [];
}

export async function createTab(label: string, workspaceId?: string): Promise<HerdrTab | undefined> {
	const args = ["tab", "create", "--label", label, "--no-focus"];
	if (workspaceId) args.push("--workspace", workspaceId);
	const res = await runHerdr(args);
	return res.ok ? parseTab(res.result) : undefined;
}

/** Close a whole tab (and all of its panes) by id. Best-effort. */
export async function closeTab(tabId: string): Promise<void> {
	await runHerdr(["tab", "close", tabId]);
}

export type SplitDirection = "right" | "down";

/**
 * Split an existing pane and return the new pane's id. `direction` is "right"
 * (new pane to the right) or "down" (new pane below). `ratio` is the fraction of
 * space the EXISTING pane keeps (the new pane gets `1 - ratio`), as confirmed
 * against the herdr CLI. Used to build an evenly-sized grid of panes.
 */
export async function splitPane(
	paneId: string,
	direction: SplitDirection,
	ratio: number,
	cwd?: string,
): Promise<{ ok: boolean; paneId?: string; error?: string }> {
	const args = ["pane", "split", paneId, "--direction", direction, "--ratio", ratio.toFixed(4), "--no-focus"];
	if (cwd) args.push("--cwd", cwd);
	const res = await runHerdr(args);
	if (!res.ok) return { ok: false, error: res.error };
	return { ok: true, paneId: parsePaneId(res.result) };
}

/** Set a pane's display label. Best-effort. */
export async function renamePane(paneId: string, label: string): Promise<void> {
	await runHerdr(["pane", "rename", paneId, label]);
}

/**
 * Start a supported interactive agent in an existing (idle shell) pane via
 * `herdr agent start`. The pane must be at its interactive shell prompt with
 * nothing running, or herdr reports `agent_pane_busy`. `name` must be a unique
 * live agent name; `childArgs` are passed to the agent verbatim after `--`.
 * Blocks until herdr detects the agent is interactive-ready (or the timeout).
 *
 * A freshly split pane can briefly still be running its shell startup (rc files
 * etc.) when we fire `agent start`, and any leftover/sibling agent keeps the
 * pane busy too. herdr rejects those immediately with `agent_pane_busy` instead
 * of queuing, so we treat that as "pane not ready yet": poll `agent start` every
 * `pollMs` until it takes, up to `readyTimeoutMs` (default 30s). On timeout we
 * return an explicit error naming the pane and the last herdr error so the
 * failure is obvious rather than a silently dropped run.
 */
export async function startAgent(
	name: string,
	kind: string,
	paneId: string,
	childArgs: string[],
	timeoutMs = 60000,
	opts?: { readyTimeoutMs?: number; pollMs?: number; signal?: AbortSignal },
): Promise<{ ok: boolean; error?: string }> {
	const args = ["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", String(timeoutMs), "--", ...childArgs];
	const readyTimeoutMs = opts?.readyTimeoutMs ?? 30000;
	const pollMs = opts?.pollMs ?? 250;
	const deadline = Date.now() + readyTimeoutMs;
	let lastBusy: string | undefined;
	for (;;) {
		const res = await runHerdr(args, timeoutMs + 5000, opts?.signal);
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
 * Submit a prompt to a live agent via `herdr agent prompt`. Unlike `agent start`
 * args, this uses bracketed paste, so multi-line text is delivered as one clean
 * user message (no shell-encoding limits, no `@file` wrapper). `target` is a
 * live agent name or the pane id hosting it. Returns immediately after
 * submission; completion is awaited separately by the caller.
 */
export async function promptAgent(target: string, text: string): Promise<{ ok: boolean; error?: string }> {
	const res = await runHerdr(["agent", "prompt", target, text]);
	return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export interface PaneAgentState {
	/** False only when herdr reports the pane no longer exists (e.g. killed). */
	exists: boolean;
	/** idle | working | blocked | done | unknown, when the pane is present. */
	status?: string;
}

/** Recursively find an `agent_status` field in a herdr result object. */
export function findAgentStatus(obj: unknown): string | undefined {
	if (!obj || typeof obj !== "object") return undefined;
	const o = obj as Record<string, unknown>;
	if (typeof o.agent_status === "string") return o.agent_status;
	for (const v of Object.values(o)) {
		const found = findAgentStatus(v);
		if (found) return found;
	}
	return undefined;
}

/**
 * Probe a pane's agent status. A `pane_not_found` error means the pane is gone
 * (terminated); any other CLI error is treated as transient so callers keep
 * waiting rather than declaring a live run dead.
 */
export async function getPaneAgentState(paneId: string): Promise<PaneAgentState> {
	const res = await runHerdr(["pane", "get", paneId]);
	if (!res.ok) {
		const gone = /not[_ ]?found/i.test(res.error ?? "");
		return { exists: !gone };
	}
	return { exists: true, status: findAgentStatus(res.result) };
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type AgentWaitResult =
	| { kind: "reached"; status: string }
	| { kind: "timeout" }
	| { kind: "not_running" }
	| { kind: "gone" };

/**
 * Block (via `herdr agent wait`) until a pane's agent reaches any of `statuses`.
 * herdr 0.7.5 replaced the old top-level `wait agent-status` with `agent wait
 * <target>`, where the target is a unique live agent name or the pane id hosting
 * it, and repeated `--until` flags resolve on the first matching state. Returns
 * which status was reached, `timeout` (deadline hit, pane alive), `not_running`
 * (no agent currently detected in the pane, e.g. still starting up), or `gone`
 * (wait aborted).
 */
export async function waitAgentStatus(
	paneId: string,
	statuses: AgentStatus[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AgentWaitResult> {
	const args = ["agent", "wait", paneId];
	for (const s of statuses) args.push("--until", s);
	args.push("--timeout", String(timeoutMs));
	const res = await runHerdr(args, timeoutMs + 5000, signal);
	if (res.ok) return { kind: "reached", status: findAgentStatus(parseLastJson(res.stdout)) ?? statuses[0] };
	const err = res.error ?? "";
	if (/tim(e|ed)\s*out|timeout/i.test(err)) return { kind: "timeout" };
	// `agent_not_running` means the pane has no detected agent yet (startup) or its
	// agent exited. The pane itself may still be alive, so callers must re-check
	// pane existence before declaring the run dead.
	if (/agent[_ ]?not[_ ]?running|not[_ ]?found/i.test(err)) return { kind: "not_running" };
	return { kind: "gone" };
}

/** Parse the last JSON object line of herdr stdout (event or result shaped). */
function parseLastJson(stdout: string | undefined): unknown {
	if (!stdout) return undefined;
	const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i].startsWith("{")) continue;
		try {
			return JSON.parse(lines[i]);
		} catch {
			// keep scanning
		}
	}
	return undefined;
}

/**
 * Production `StatusProbe` (see pane-lifecycle.ts) bound to a herdr pane: the
 * blocking wait maps to `herdr agent wait`, and the point probe to `pane get`.
 * Keeps the lifecycle machine free of any herdr/pane-id knowledge.
 */
export function herdrStatusProbe(paneId: string): StatusProbe {
	return {
		waitUntil: (statuses, timeoutMs, signal) => waitAgentStatus(paneId, statuses, timeoutMs, signal),
		peek: () => getPaneAgentState(paneId),
	};
}

/** Read recent pane output as a fallback when the output file is missing. */
export async function readPane(paneId: string, lines = 200): Promise<string | undefined> {
	const res = await runHerdr(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines), "--format", "text"]);
	if (!res.ok || !res.result) return undefined;
	const text = res.result.text ?? res.result.output ?? res.result.content;
	return typeof text === "string" ? text : undefined;
}
