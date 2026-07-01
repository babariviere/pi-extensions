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
export function runHerdr(args: string[], timeoutMs = 10000): Promise<HerdrCliResult> {
	return new Promise((resolve) => {
		execFile("herdr", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
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

/** Close a pane by id. Best-effort. */
export async function closePane(paneId: string): Promise<void> {
	await runHerdr(["pane", "close", paneId]);
}

/** Close a whole tab (and all of its panes) by id. Best-effort. */
export async function closeTab(tabId: string): Promise<void> {
	await runHerdr(["tab", "close", tabId]);
}

export interface StartAgentOpts {
	label: string;
	tabId: string;
	cwd?: string;
	env?: Record<string, string>;
	/** argv to run in the pane, e.g. ["pi", "--session", ...]. */
	argv: string[];
}

/** Start a command in a new pane inside the given tab. Returns the pane id. */
export async function startAgentPane(opts: StartAgentOpts): Promise<{ ok: boolean; paneId?: string; error?: string }> {
	const args = ["agent", "start", opts.label, "--tab", opts.tabId, "--split", "down", "--no-focus"];
	if (opts.cwd) args.push("--cwd", opts.cwd);
	for (const [k, v] of Object.entries(opts.env ?? {})) {
		args.push("--env", `${k}=${v}`);
	}
	args.push("--", ...opts.argv);
	const res = await runHerdr(args);
	if (!res.ok) return { ok: false, error: res.error };
	return { ok: true, paneId: parsePaneId(res.result) };
}

/** Block until the pi agent in a pane reports `done`. Best-effort. */
export async function waitAgentDone(paneId: string, timeoutMs: number): Promise<boolean> {
	const res = await runHerdr(["wait", "agent-status", paneId, "--status", "done", "--timeout", String(timeoutMs)], timeoutMs + 5000);
	return res.ok;
}

/** Read recent pane output as a fallback when the output file is missing. */
export async function readPane(paneId: string, lines = 200): Promise<string | undefined> {
	const res = await runHerdr(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines), "--format", "text"]);
	if (!res.ok || !res.result) return undefined;
	const text = res.result.text ?? res.result.output ?? res.result.content;
	return typeof text === "string" ? text : undefined;
}
