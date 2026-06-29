/**
 * Linear extension for pi
 *
 * Command:
 *   /linear                e.g. /linear
 *     Lists the issues assigned to you in the current sprint (active cycle).
 *   /linear <TICKET-ID>   e.g. /linear SECGO-123
 *     1. Fetches the ticket from Linear.
 *     2. Marks it as In Progress (best effort).
 *     3. Shows the active ticket in the status line.
 *     4. Triggers /feature with the ticket as the spec so we deep-dive the setup.
 *
 * Config / secrets:
 *   LINEAR_API_KEY via env or ~/.pi/agent/secrets.json (personal API key, "lin_api_...").
 *
 * Install:
 *   Auto-discovered from ~/.pi/agent/extensions/linear.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

const LINEAR_API = "https://api.linear.app/graphql";
const STATUS_KEY = "linear";
const ENTRY_TYPE = "linear-ticket";

interface IssueState {
	id: string;
	name: string;
	type: string;
}

interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	url: string;
	state: IssueState | null;
	team: { id: string; key: string } | null;
}

interface ActiveTicket {
	identifier: string;
	title: string;
	url: string;
	stateName: string;
}

/** Resolve the Linear API key from env or ~/.pi/agent/secrets.json. */
function getLinearApiKey(): string | null {
	if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY.trim();
	try {
		const secretsPath = join(agentDir(), "secrets.json");
		if (existsSync(secretsPath)) {
			const secrets = JSON.parse(readFileSync(secretsPath, "utf-8")) as Record<string, string>;
			if (secrets.LINEAR_API_KEY) return secrets.LINEAR_API_KEY.trim();
		}
	} catch {
		// fall through
	}
	return null;
}

/** Locate a prompt template's file path via the runtime command registry (pi.getCommands). */
function findPromptTemplatePath(pi: ExtensionAPI, name: string): string | null {
	const getCommands = (
		pi as unknown as {
			getCommands?: () => Array<{ name: string; source: string; sourceInfo?: { path?: string } }>;
		}
	).getCommands;
	if (typeof getCommands !== "function") return null;
	const match = getCommands.call(pi).find((c) => c.source === "prompt" && c.name === name);
	return match?.sourceInfo?.path ?? null;
}

/** Read a prompt template body, stripping YAML frontmatter (same delimiters pi uses). */
function loadPromptTemplateBody(path: string): string {
	const raw = readFileSync(path, "utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (raw.startsWith("---")) {
		const end = raw.indexOf("\n---", 3);
		if (end !== -1) return raw.slice(end + 4).trim();
	}
	return raw.trim();
}

async function linearGraphQL<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
	const res = await fetch(LINEAR_API, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: apiKey },
		body: JSON.stringify({ query, variables }),
	});
	if (!res.ok) {
		throw new Error(`Linear API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
	}
	const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
	if (json.errors?.length) {
		throw new Error(`Linear API error: ${json.errors.map((e) => e.message).join("; ")}`);
	}
	if (!json.data) throw new Error("Linear API returned no data");
	return json.data;
}

function parseIdentifier(input: string): { teamKey: string; number: number } | null {
	const m = input.trim().toUpperCase().match(/^([A-Z][A-Z0-9]*)-(\d+)$/);
	if (!m) return null;
	return { teamKey: m[1], number: Number(m[2]) };
}

async function fetchIssue(apiKey: string, teamKey: string, number: number): Promise<LinearIssue | null> {
	const data = await linearGraphQL<{ issues: { nodes: LinearIssue[] } }>(
		apiKey,
		`query Find($team: String!, $number: Float!) {
			issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) {
				nodes { id identifier title description url state { id name type } team { id key } }
			}
		}`,
		{ team: teamKey, number },
	);
	return data.issues.nodes[0] ?? null;
}

/** Find the team's "In Progress" workflow state (type "started"; prefer the name "In Progress"). */
async function findInProgressState(apiKey: string, teamKey: string): Promise<IssueState | null> {
	const data = await linearGraphQL<{ workflowStates: { nodes: IssueState[] } }>(
		apiKey,
		`query States($team: String!) {
			workflowStates(filter: { team: { key: { eq: $team } }, type: { eq: "started" } }) {
				nodes { id name type }
			}
		}`,
		{ team: teamKey },
	);
	const states = data.workflowStates.nodes;
	if (states.length === 0) return null;
	return states.find((s) => s.name.toLowerCase() === "in progress") ?? states[0];
}

async function fetchCurrentSprintIssues(apiKey: string): Promise<LinearIssue[]> {
	const data = await linearGraphQL<{ issues: { nodes: LinearIssue[] } }>(
		apiKey,
		`query CurrentSprint {
			issues(
				filter: {
					assignee: { isMe: { eq: true } }
					cycle: { isActive: { eq: true } }
				}
				first: 100
			) {
				nodes { id identifier title description url state { id name type } team { id key } }
			}
		}`,
		{},
	);
	return data.issues.nodes;
}

async function setIssueState(apiKey: string, issueId: string, stateId: string): Promise<boolean> {
	const data = await linearGraphQL<{ issueUpdate: { success: boolean } }>(
		apiKey,
		`mutation Update($id: String!, $stateId: String!) {
			issueUpdate(id: $id, input: { stateId: $stateId }) { success }
		}`,
		{ id: issueId, stateId },
	);
	return data.issueUpdate.success;
}

function showStatus(ctx: ExtensionContext, ticket: ActiveTicket): void {
	const title = ticket.title.length > 40 ? `${ticket.title.slice(0, 39)}…` : ticket.title;
	ctx.ui.setStatus(STATUS_KEY, `🎫 ${ticket.identifier} ${title}`);
}

/** Mark the issue In Progress (best effort) and hand off to /feature. */
async function startFeatureForIssue(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	apiKey: string,
	issue: LinearIssue,
	extraContext: string,
): Promise<void> {
	const teamKey = issue.team?.key ?? parseIdentifier(issue.identifier)?.teamKey ?? "";

	// Mark In Progress (best effort; don't block the workflow if it fails).
	let stateName = issue.state?.name ?? "Unknown";
	try {
		const inProgress = teamKey ? await findInProgressState(apiKey, teamKey) : null;
		if (!inProgress) {
			ctx.ui.notify(`No "In Progress" (started) state found for team ${teamKey}.`, "warning");
		} else if (issue.state?.id === inProgress.id) {
			stateName = inProgress.name;
		} else if (await setIssueState(apiKey, issue.id, inProgress.id)) {
			stateName = inProgress.name;
			ctx.ui.notify(`Marked ${issue.identifier} as ${inProgress.name}.`, "info");
		} else {
			ctx.ui.notify(`Could not update ${issue.identifier} state.`, "warning");
		}
	} catch (err) {
		ctx.ui.notify(`State update failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
	}

	const ticket: ActiveTicket = {
		identifier: issue.identifier,
		title: issue.title,
		url: issue.url,
		stateName,
	};
	showStatus(ctx, ticket);
	pi.appendEntry(ENTRY_TYPE, ticket);

	// Build the ticket spec that fills the /feature template's $@ placeholder.
	const specText = [
		`${issue.identifier}: ${issue.title}`,
		"",
		`Linear ticket ${issue.identifier} (${issue.url}), now ${stateName}.`,
		"",
		issue.description?.trim() || "(no description provided in the ticket)",
		...(extraContext ? ["", "Additional context from the operator:", extraContext] : []),
	].join("\n");

	// sendUserMessage does NOT run command/template expansion, so we expand the
	// /feature prompt template ourselves: locate its file via pi.getCommands(),
	// strip frontmatter, and substitute $@/$ARGUMENTS with the ticket spec.
	// Use a replacer function so any `$` in the description isn't treated as a
	// regex replacement token (e.g. $&, $1).
	const templatePath = findPromptTemplatePath(pi, "feature");
	if (templatePath) {
		const body = loadPromptTemplateBody(templatePath);
		pi.sendUserMessage(body.replace(/\$ARGUMENTS\b|\$@/g, () => specText));
	} else {
		ctx.ui.notify("Prompt template /feature not found; sending the raw ticket spec.", "warning");
		pi.sendUserMessage(specText);
	}
}

interface SprintPick {
	issue: LinearIssue;
	context: string;
}

/** Interactive picker: choose a sprint issue, then optionally type extra context. */
class SprintPickerComponent implements Component {
	private issues: LinearIssue[];
	private tui: TUI;
	private onDone: (result: SprintPick | null) => void;
	private phase: "select" | "context" = "select";
	private selected = 0;
	private editor: Editor;

	private cachedWidth?: number;
	private cachedLines?: string[];

	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	constructor(issues: LinearIssue[], tui: TUI, onDone: (result: SprintPick | null) => void) {
		this.issues = issues;
		this.tui = tui;
		this.onDone = onDone;

		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedPrefix: this.cyan,
				selectedText: this.cyan,
				description: this.gray,
				scrollInfo: this.gray,
				noMatch: this.gray,
			},
		};
		this.editor = new Editor(tui, editorTheme);
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onDone(null);
			return;
		}

		if (this.phase === "select") {
			if (matchesKey(data, Key.escape)) {
				this.onDone(null);
				return;
			}
			if (matchesKey(data, Key.up)) {
				this.selected = (this.selected - 1 + this.issues.length) % this.issues.length;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.selected = (this.selected + 1) % this.issues.length;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.phase = "context";
				this.editor.setText("");
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		// phase === "context"
		if (matchesKey(data, Key.escape)) {
			// Go back to the selection list.
			this.phase = "select";
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.onDone({ issue: this.issues[this.selected], context: this.editor.getText().trim() });
			return;
		}
		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120);
		const contentWidth = boxWidth - 4;
		const hr = (count: number) => "─".repeat(count);
		const boxLine = (content: string, leftPad = 2): string => {
			const padded = " ".repeat(leftPad) + content;
			const rightPad = Math.max(0, boxWidth - visibleWidth(padded) - 2);
			return this.dim("│") + padded + " ".repeat(rightPad) + this.dim("│");
		};
		const emptyBoxLine = (): string => this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
		const pad = (line: string): string => line + " ".repeat(Math.max(0, width - visibleWidth(line)));

		lines.push(pad(this.dim("╭" + hr(boxWidth - 2) + "╮")));
		const title =
			this.phase === "select"
				? `${this.bold(this.cyan("Current sprint"))} ${this.dim(`(${this.issues.length})`)}`
				: this.bold(this.cyan("Add optional context"));
		lines.push(pad(boxLine(title)));
		lines.push(pad(this.dim("├" + hr(boxWidth - 2) + "┤")));

		if (this.phase === "select") {
			this.issues.forEach((issue, i) => {
				const marker = i === this.selected ? this.cyan("❯ ") : "  ";
				const state = this.gray(`[${issue.state?.name ?? "Unknown"}]`);
				const label = `${marker}${this.bold(issue.identifier)} ${state} ${issue.title}`;
				lines.push(pad(boxLine(truncateToWidth(label, contentWidth))));
			});
			lines.push(pad(this.dim("├" + hr(boxWidth - 2) + "┤")));
			const controls = `${this.dim("↑/↓")} move · ${this.dim("Enter")} select · ${this.dim("Esc")} cancel`;
			lines.push(pad(boxLine(truncateToWidth(controls, contentWidth))));
		} else {
			const issue = this.issues[this.selected];
			const head = `${this.bold(issue.identifier)} ${issue.title}`;
			for (const l of wrapTextWithAnsi(head, contentWidth)) lines.push(pad(boxLine(l)));
			lines.push(pad(emptyBoxLine()));
			const editorLines = this.editor.render(contentWidth - 4);
			for (let i = 1; i < editorLines.length - 1; i++) {
				lines.push(pad(boxLine("  " + editorLines[i])));
			}
			lines.push(pad(this.dim("├" + hr(boxWidth - 2) + "┤")));
			const controls = `${this.dim("Enter")} start · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} back`;
			lines.push(pad(boxLine(truncateToWidth(controls, contentWidth))));
		}

		lines.push(pad(this.dim("╰" + hr(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function (pi: ExtensionAPI): void {
	// Restore the active ticket in the status line on session load.
	pi.on("session_start", async (_event, ctx) => {
		let latest: ActiveTicket | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				latest = entry.data as ActiveTicket;
			}
		}
		if (latest) showStatus(ctx, latest);
	});

	pi.registerCommand("linear", {
		description: "Fetch a Linear ticket, mark it In Progress, and start /feature on it",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();

			const apiKey = getLinearApiKey();
			if (!apiKey) {
				ctx.ui.notify(
					"No Linear API key. Set LINEAR_API_KEY via env or ~/.pi/agent/secrets.json.",
					"error",
				);
				return;
			}

			// No ticket id: list the issues assigned to me in the current sprint (active cycle).
			if (!raw) {
				ctx.ui.notify("Fetching your current sprint issues from Linear…", "info");
				let issues: LinearIssue[];
				try {
					issues = await fetchCurrentSprintIssues(apiKey);
				} catch (err) {
					ctx.ui.notify(`Linear fetch failed: ${err instanceof Error ? err.message : String(err)}`, "error");
					return;
				}
				if (issues.length === 0) {
					ctx.ui.notify("No issues assigned to you in the current sprint.", "info");
					return;
				}

				const pick = await ctx.ui.custom<SprintPick | null>(
					(tui, _theme, _kb, done) => new SprintPickerComponent(issues, tui, done),
				);
				if (!pick) {
					ctx.ui.notify("Cancelled", "info");
					return;
				}

				await startFeatureForIssue(pi, ctx, apiKey, pick.issue, pick.context);
				return;
			}

			// First token is the ticket id; anything after it is free-form context for /feature.
			const firstSpace = raw.search(/\s/);
			const ticketArg = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
			const extraContext = firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();

			const parsed = parseIdentifier(ticketArg);
			if (!parsed) {
				ctx.ui.notify(`Invalid ticket id "${ticketArg}". Expected something like SECGO-123.`, "error");
				return;
			}

			ctx.ui.notify(`Fetching ${parsed.teamKey}-${parsed.number} from Linear…`, "info");

			let issue: LinearIssue | null;
			try {
				issue = await fetchIssue(apiKey, parsed.teamKey, parsed.number);
			} catch (err) {
				ctx.ui.notify(`Linear fetch failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
			if (!issue) {
				ctx.ui.notify(`Ticket ${parsed.teamKey}-${parsed.number} not found.`, "error");
				return;
			}

			await startFeatureForIssue(pi, ctx, apiKey, issue, extraContext);
		},
	});
}
