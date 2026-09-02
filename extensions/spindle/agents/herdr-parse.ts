/**
 * herdr CLI response parsing: pure, defensive helpers over the JSON the `herdr`
 * CLI prints. No I/O — the transport (`herdr-transport.ts`) shells out and the
 * client (`herdr-client.ts`) builds args; these just parse. Exported for unit
 * testing without a live herdr server.
 *
 * The CLI prints a single JSON-RPC-shaped line to stdout, e.g.
 *   {"id":"cli:tab:list","result":{"tabs":[...],"type":"tab_list"}}
 * tolerating leading log lines, so every parser scans for the last JSON object
 * line (see `lastJsonLine`).
 */

export interface HerdrCliResult {
	ok: boolean;
	result?: Record<string, unknown>;
	error?: string;
	stdout?: string;
}

export interface HerdrTab {
	tabId: string;
	label?: string;
	workspaceId?: string;
	/** The pane herdr always creates alongside a new tab (empty shell). */
	rootPaneId?: string;
}

export interface PaneAgentState {
	/** False only when herdr reports the pane no longer exists (e.g. killed). */
	exists: boolean;
	/** idle | working | blocked | done | unknown, when the pane is present. */
	status?: string;
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type AgentWaitResult =
	| { kind: "reached"; status: string }
	| { kind: "timeout" }
	| { kind: "not_running" }
	| { kind: "gone" };

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

/**
 * True when a `herdr agent prompt --wait` error means the text landed in the
 * agent's composer but no turn ever started: herdr saw no state change within
 * its submission window and reported `agent_prompt_stalled`. The prompt itself
 * is already in the input, so the repair is to replay the submit key, never to
 * re-send the prompt.
 */
export function isPromptStalledError(error: string | undefined): boolean {
	return /agent[_ ]?prompt[_ ]?stalled/i.test(error ?? "");
}

/**
 * True when herdr rejected a submission because the agent is blocked (waiting on
 * a permission prompt or similar). herdr rejects before sending any input, so
 * there is nothing in the composer and nothing to repair.
 */
export function isAgentBlockedError(error: string | undefined): boolean {
	return /agent[_ ]?blocked/i.test(error ?? "");
}

/** True when a herdr CLI error is a plain deadline expiry rather than a fault. */
export function isTimeoutError(error: string | undefined): boolean {
	return /tim(e|ed)\s*out|timeout/i.test(error ?? "");
}

/**
 * Parse the last JSON object line of herdr stdout (event- or result-shaped),
 * tolerating leading log lines. Returns undefined when no JSON line is present.
 * The single scanner both `parseHerdrJson` and the client's `waitAgentStatus`
 * build on.
 */
export function lastJsonLine(stdout: string | undefined): unknown {
	if (!stdout) return undefined;
	const lines = stdout
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i].startsWith("{")) continue;
		try {
			return JSON.parse(lines[i]);
		} catch {
			// Not JSON; keep scanning earlier lines.
		}
	}
	return undefined;
}

/**
 * Normalize a herdr CLI response to `{ ok, result | error }`. Returns undefined
 * when no JSON is present (some commands succeed silently; the transport treats
 * that as an empty-result success).
 */
export function parseHerdrJson(stdout: string): HerdrCliResult | undefined {
	const msg = lastJsonLine(stdout) as { result?: Record<string, unknown>; error?: unknown } | undefined;
	if (msg === undefined) return undefined;
	if (msg.error) {
		const message =
			typeof msg.error === "object" && msg.error && "message" in msg.error
				? String((msg.error as { message?: unknown }).message ?? "herdr error")
				: String(msg.error);
		return { ok: false, error: message };
	}
	return { ok: true, result: msg.result ?? {} };
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
			workspaceId:
				typeof o.workspace_id === "string"
					? o.workspace_id
					: typeof o.workspaceId === "string"
						? o.workspaceId
						: undefined,
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
		result.root_pane && typeof result.root_pane === "object"
			? (result.root_pane as Record<string, unknown>)
			: undefined,
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
