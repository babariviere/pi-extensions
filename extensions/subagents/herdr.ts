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
			resolve({ ok: false, error: "could not parse herdr output", stdout: text });
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

/**
 * Split an existing pane vertically and return the new pane's id. `ratio` is the
 * fraction of space the EXISTING pane keeps (the new pane gets `1 - ratio`), as
 * confirmed against the herdr CLI. Used to build an evenly-sized pane stack.
 */
export async function splitPaneDown(paneId: string, ratio: number, cwd?: string): Promise<{ ok: boolean; paneId?: string; error?: string }> {
	const args = ["pane", "split", paneId, "--direction", "down", "--ratio", ratio.toFixed(4), "--no-focus"];
	if (cwd) args.push("--cwd", cwd);
	const res = await runHerdr(args);
	if (!res.ok) return { ok: false, error: res.error };
	return { ok: true, paneId: parsePaneId(res.result) };
}

/** Set a pane's display label. Best-effort. */
export async function renamePane(paneId: string, label: string): Promise<void> {
	await runHerdr(["pane", "rename", paneId, label]);
}

/** Run a shell command line in an existing pane (types it and presses Enter). */
export async function runInPane(paneId: string, command: string): Promise<{ ok: boolean; error?: string }> {
	const res = await runHerdr(["pane", "run", paneId, command]);
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
	| { kind: "gone" };

/**
 * Block (via `herdr wait agent-status`) until a pane reaches any of `statuses`.
 * herdr accepts repeated `--status` flags and resolves on the first match, so we
 * don't need to race multiple processes. Returns which status was reached, or
 * `timeout` (deadline hit, pane alive) / `gone` (pane removed or wait aborted).
 */
export async function waitAgentStatus(
	paneId: string,
	statuses: AgentStatus[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AgentWaitResult> {
	const args = ["wait", "agent-status", paneId];
	for (const s of statuses) args.push("--status", s);
	args.push("--timeout", String(timeoutMs));
	const res = await runHerdr(args, timeoutMs + 5000, signal);
	if (res.ok) return { kind: "reached", status: findAgentStatus(parseLastJson(res.stdout)) ?? statuses[0] };
	if (/tim(e|ed)\s*out|timeout/i.test(res.error ?? "")) return { kind: "timeout" };
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
 * Wait for a subagent pane to finish its turn, using blocking status waits
 * instead of busy polling. pi's observed lifecycle is `unknown -> idle -> working
 * -> (idle | done)`: it emits a brief `idle` at startup before picking up the
 * task, and when finished a focused pane goes `idle` while a background pane goes
 * `done`. So we first wait for `working` (skipping the startup `idle`), then wait
 * for `idle` or `done`.
 *
 * Termination handling: `herdr wait agent-status` does NOT error promptly when a
 * pane is closed mid-wait; it blocks until its own `--timeout`. So we cap each
 * wait at `chunkMs` and re-check pane existence between chunks, bounding
 * `gone`-detection latency to ~chunkMs while finishes still resolve instantly.
 */
export async function waitForAgentFinish(
	paneId: string,
	timeoutMs: number,
	opts?: { signal?: AbortSignal; chunkMs?: number },
): Promise<"finished" | "gone"> {
	const signal = opts?.signal;
	const chunkMs = opts?.chunkMs ?? 20000;
	const deadline = Date.now() + timeoutMs;

	// Phase 1: wait until the agent is actively working, so the startup `idle`
	// isn't mistaken for completion. A very fast background agent may reach `done`
	// before we see `working`; that counts as finished too.
	while (Date.now() < deadline && !signal?.aborted) {
		const remaining = deadline - Date.now();
		const r = await waitAgentStatus(paneId, ["working", "done"], Math.min(chunkMs, remaining), signal);
		if (r.kind === "gone") return "gone";
		if (r.kind === "reached") {
			if (r.status === "done") return "finished";
			break; // working
		}
		// Chunk elapsed without `working`: re-check existence / fast-finish.
		const state = await getPaneAgentState(paneId);
		if (!state.exists) return "gone";
		if (state.status === "idle" || state.status === "done") return "finished";
		if (state.status === "blocked") break; // active but paused; wait for finish
		// Otherwise still starting (unknown); keep waiting for `working`.
	}

	// Phase 2: wait for completion. Focused panes go `idle`, background panes go
	// `done`; accept whichever comes first. Re-check existence each chunk so a
	// pane the user terminated is noticed promptly instead of at the full timeout.
	while (Date.now() < deadline && !signal?.aborted) {
		const remaining = deadline - Date.now();
		const r = await waitAgentStatus(paneId, ["idle", "done"], Math.min(chunkMs, remaining), signal);
		if (r.kind === "reached") return "finished";
		if (r.kind === "gone") return "gone";
		// Chunk timeout: confirm the pane is still alive before waiting again.
		const state = await getPaneAgentState(paneId);
		if (!state.exists) return "gone";
		if (state.status === "done" || state.status === "idle") return "finished";
	}
	return "finished";
}

/** Read recent pane output as a fallback when the output file is missing. */
export async function readPane(paneId: string, lines = 200): Promise<string | undefined> {
	const res = await runHerdr(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines), "--format", "text"]);
	if (!res.ok || !res.result) return undefined;
	const text = res.result.text ?? res.result.output ?? res.result.content;
	return typeof text === "string" ? text : undefined;
}
