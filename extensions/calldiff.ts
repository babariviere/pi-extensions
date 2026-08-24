/**
 * calldiff
 *
 * Wraps the `calldiff` CLI (https://github.com/tanishqkancharla/calldiff), which
 * diffs *call trees* between two git trees instead of lines.
 *
 * Two surfaces, one shared runner:
 *
 *   1. Auto panel. After the agent settles, if the working copy changed during
 *      the run, `calldiff diff` (HEAD vs working tree) is executed and rendered
 *      as a custom entry. Custom entries never enter LLM context, so this costs
 *      the agent nothing and is for the human reviewer only.
 *
 *   2. `calldiff` tool. The agent can call diff / tree / reach itself when it
 *      wants to verify a refactor or trace reachability.
 *
 * Commands:
 *   /calldiff            Run the panel now against the current change.
 *   /calldiff <ref>      Diff <ref> against the working tree.
 *   /calldiff on|off     Toggle the automatic panel (default on, persisted).
 *   /calldiff status     Show current setting and resolved binary.
 *
 * Requirements:
 *   - `calldiff` on PATH (preferred) or npx fallback (`npx -y calldiff@latest`).
 *   - A git repo. jj works only when the repo is colocated (`.git` present),
 *     because calldiff reads refs via `git show`.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const ENTRY_TYPE = "calldiff";
const PANEL_TREE_LIMIT = 3;
const PANEL_TIMEOUT_MS = 20_000;
const TOOL_TIMEOUT_MS = 30_000;
const TOOL_CHAR_BUDGET = 8_000;
const PANEL_CHAR_BUDGET = 20_000;

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

type Mode = "diff" | "tree" | "reach";

interface CalldiffTree {
	entry?: string;
	ascii?: string;
	[key: string]: unknown;
}

interface CalldiffResult {
	mode?: string;
	from?: string;
	to?: string;
	trees?: CalldiffTree[];
	paths?: unknown[];
	[key: string]: unknown;
}

/** Data persisted for the TUI-only panel entry. */
interface PanelData {
	from: string;
	to: string;
	shown: { entry: string; ascii: string }[];
	hidden: number;
	ms: number;
}

interface RunOk {
	ok: true;
	data: CalldiffResult;
	ms: number;
}

interface RunErr {
	ok: false;
	error: string;
}

type RunResult = RunOk | RunErr;

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

interface Settings {
	auto: boolean;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function settingsPath(): string {
	return join(agentDir(), "calldiff.json");
}

async function loadSettings(): Promise<Settings> {
	try {
		const parsed = JSON.parse(await readFile(settingsPath(), "utf8")) as Partial<Settings>;
		return { auto: parsed?.auto !== false };
	} catch {
		return { auto: true };
	}
}

async function saveSettings(settings: Settings): Promise<void> {
	const file = settingsPath();
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// binary resolution + runner
// ---------------------------------------------------------------------------

interface Bin {
	cmd: string;
	args: string[];
	label: string;
}

let binCache: Bin | null = null;

async function resolveBin(pi: ExtensionAPI): Promise<Bin> {
	if (binCache) return binCache;
	let found = "";
	try {
		const which = await pi.exec("sh", ["-lc", "command -v calldiff"], { timeout: 5_000 });
		if (which.code === 0) found = which.stdout.trim().split("\n")[0]?.trim() ?? "";
	} catch {
		found = "";
	}
	binCache = found
		? { cmd: found, args: [], label: found }
		: { cmd: "npx", args: ["-y", "calldiff@latest"], label: "npx calldiff@latest (not installed locally)" };
	return binCache;
}

/**
 * `calldiff` exits non-zero for real failures but also prints diagnostics on
 * stderr while succeeding, so trust stdout JSON first and only fall back to the
 * exit code when nothing parseable came back.
 */
async function runCalldiff(
	pi: ExtensionAPI,
	cwd: string,
	argv: string[],
	signal: AbortSignal | undefined,
	timeout: number,
): Promise<RunResult> {
	const bin = await resolveBin(pi);
	const started = Date.now();
	let res: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	try {
		res = await pi.exec(bin.cmd, [...bin.args, ...argv, "--format", "json"], { cwd, signal, timeout });
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
	const ms = Date.now() - started;
	if (res.killed) return { ok: false, error: `calldiff timed out after ${timeout}ms` };

	const stdout = res.stdout.trim();
	const start = stdout.indexOf("{");
	if (start >= 0) {
		try {
			return { ok: true, data: JSON.parse(stdout.slice(start)) as CalldiffResult, ms };
		} catch {
			// fall through to the error path
		}
	}
	const detail = res.stderr.trim() || stdout || `exit ${res.code}`;
	return { ok: false, error: detail.split("\n").slice(0, 4).join("\n") };
}

// ---------------------------------------------------------------------------
// result shaping
// ---------------------------------------------------------------------------

/** A tree is only interesting when its ascii actually carries +/- markers. */
function hasChange(ascii: string): boolean {
	return ascii.split("\n").some((line) => line.startsWith("+") || line.startsWith("-"));
}

function treeEntries(data: CalldiffResult, requireChange: boolean): { entry: string; ascii: string }[] {
	const trees = Array.isArray(data.trees) ? data.trees : [];
	const out: { entry: string; ascii: string }[] = [];
	for (const tree of trees) {
		const ascii = typeof tree.ascii === "string" ? tree.ascii.trimEnd() : "";
		if (!ascii) continue;
		if (requireChange && !hasChange(ascii)) continue;
		out.push({ entry: typeof tree.entry === "string" ? tree.entry : "(unknown)", ascii });
	}
	return out;
}

function clip(text: string, budget: number): string {
	if (text.length <= budget) return text;
	return `${text.slice(0, budget)}\n… truncated (${text.length - budget} more chars)`;
}

/**
 * Compact text for the LLM. The nested `tree` objects duplicate everything the
 * ascii already says at several times the token cost, so only ascii is kept.
 */
function formatForAgent(data: CalldiffResult): string {
	const mode = data.mode ?? "diff";
	const header =
		mode === "diff" ? `calldiff ${mode} ${data.from ?? "HEAD"} -> ${data.to ?? "working tree"}` : `calldiff ${mode}`;

	if (Array.isArray(data.paths)) {
		if (data.paths.length === 0) return `${header}\n\nNo call paths found.`;
		return clip(`${header}\n\n${JSON.stringify(data.paths, null, 1)}`, TOOL_CHAR_BUDGET);
	}

	const entries = treeEntries(data, mode === "diff");
	if (entries.length === 0) {
		return mode === "diff"
			? `${header}\n\nNo call-flow change detected. Do not retry with different arguments; the edits did not alter the call graph.`
			: `${header}\n\nNo call tree produced for the requested entrypoint.`;
	}

	const body = entries.map((e) => `## ${e.entry}\n${e.ascii}`).join("\n\n");
	return clip(`${header}\n\n${body}`, TOOL_CHAR_BUDGET);
}

function toPanelData(data: CalldiffResult, ms: number): PanelData | null {
	const entries = treeEntries(data, true);
	if (entries.length === 0) return null;
	const shown = entries.slice(0, Math.max(PANEL_TREE_LIMIT, 1));
	return {
		from: data.from ?? "HEAD",
		to: data.to ?? "working tree",
		shown,
		hidden: entries.length - shown.length,
		ms,
	};
}

// ---------------------------------------------------------------------------
// working copy fingerprint
// ---------------------------------------------------------------------------

/**
 * Cheap "did anything change" probe. Deliberately not based on tool names:
 * edits routed through spindle_exec never surface as `edit`/`write` tool
 * events, and bash can rewrite files too.
 */
async function fingerprint(pi: ExtensionAPI, cwd: string): Promise<string> {
	const useJj = existsSync(join(cwd, ".jj"));
	try {
		const res = useJj
			? await pi.exec("jj", ["diff", "--summary", "--color", "never"], { cwd, timeout: 10_000 })
			: await pi.exec("git", ["status", "--porcelain"], { cwd, timeout: 10_000 });
		if (res.code !== 0) return "";
		return res.stdout;
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function colorize(theme: Theme, ascii: string): string {
	return ascii
		.split("\n")
		.map((line) => {
			if (line.startsWith("+")) return theme.fg("success", line);
			if (line.startsWith("-")) return theme.fg("error", line);
			return theme.fg("muted", line);
		})
		.join("\n");
}

function renderPanel(theme: Theme, data: PanelData, expanded: boolean): string {
	const head =
		theme.fg("toolTitle", theme.bold("calldiff ")) +
		theme.fg("muted", `${data.from} → ${data.to}`) +
		theme.fg("dim", ` (${data.ms}ms)`);

	const blocks = data.shown.map(
		(entry) => `${theme.fg("accent", entry.entry)}\n${colorize(theme, entry.ascii)}`,
	);
	let body = blocks.join("\n\n");
	if (!expanded) body = clip(body, PANEL_CHAR_BUDGET);

	const parts = [head, body];
	if (data.hidden > 0) {
		parts.push(theme.fg("dim", `+ ${data.hidden} more changed entrypoint(s)`));
	}
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function calldiffExtension(pi: ExtensionAPI): void {
	let settings: Settings = { auto: true };
	void loadSettings().then((loaded) => {
		settings = loaded;
	});

	/** Fingerprint captured when the agent started running. */
	let baseline: string | null = null;
	/** Result the agent already produced this run, reused by the panel. */
	let turnCache: { key: string; data: CalldiffResult; ms: number } | null = null;

	const cacheKey = (argv: string[]) => argv.join("\u0000");

	async function run(
		cwd: string,
		argv: string[],
		signal: AbortSignal | undefined,
		timeout: number,
	): Promise<RunResult> {
		const key = cacheKey(argv);
		if (turnCache && turnCache.key === key) {
			return { ok: true, data: turnCache.data, ms: turnCache.ms };
		}
		const result = await runCalldiff(pi, cwd, argv, signal, timeout);
		if (result.ok) turnCache = { key, data: result.data, ms: result.ms };
		return result;
	}

	async function showPanel(cwd: string, argv: string[], signal: AbortSignal | undefined): Promise<PanelData | null> {
		const result = await run(cwd, argv, signal, PANEL_TIMEOUT_MS);
		if (!result.ok) return null;
		const panel = toPanelData(result.data, result.ms);
		if (panel) pi.appendEntry(ENTRY_TYPE, panel);
		return panel;
	}

	// -- TUI-only panel ------------------------------------------------------

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data as PanelData | undefined;
		if (!data?.shown?.length) return new Text("", 0, 0);
		return new Text(renderPanel(theme, data, expanded), 1, 0);
	});

	pi.on("agent_start", async (_event, ctx) => {
		turnCache = null;
		baseline = await fingerprint(pi, ctx.cwd);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const before = baseline;
		baseline = null;
		if (!settings.auto || !ctx.hasUI || before === null) return;
		// Only git-backed trees work; jj must be colocated.
		if (!existsSync(join(ctx.cwd, ".git"))) return;

		const after = await fingerprint(pi, ctx.cwd);
		if (after === before) return;

		try {
			await showPanel(ctx.cwd, ["diff"], ctx.signal);
		} catch {
			// Review aid only; never surface failures during a turn boundary.
		}
	});

	// -- command -------------------------------------------------------------

	pi.registerCommand("calldiff", {
		description: "Show the call-stack diff for the current change (on|off|status|<ref>)",
		getArgumentCompletions: (prefix: string) => {
			const items = ["on", "off", "status"].map((value) => ({ value, label: value }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();

			if (arg === "on" || arg === "off") {
				settings = { auto: arg === "on" };
				await saveSettings(settings);
				ctx.ui.notify(`calldiff: auto panel ${arg}`, "info");
				return;
			}

			if (arg === "status") {
				const bin = await resolveBin(pi);
				const colocated = existsSync(join(ctx.cwd, ".git"));
				ctx.ui.notify(
					`calldiff: auto=${settings.auto ? "on" : "off"}, bin=${bin.label}${colocated ? "" : ", no .git (jj must be colocated)"}`,
					colocated ? "info" : "warning",
				);
				return;
			}

			if (!existsSync(join(ctx.cwd, ".git"))) {
				ctx.ui.notify("calldiff: needs a git repo (colocate the jj repo with `jj git init --colocate`)", "error");
				return;
			}

			const argv = arg ? ["diff", arg] : ["diff"];
			ctx.ui.notify("calldiff: computing call-stack diff…", "info");
			turnCache = null;
			const result = await run(ctx.cwd, argv, ctx.signal, PANEL_TIMEOUT_MS);
			if (!result.ok) {
				ctx.ui.notify(`calldiff: ${result.error}`, "error");
				return;
			}
			const panel = toPanelData(result.data, result.ms);
			if (!panel) {
				ctx.ui.notify("calldiff: no call-flow change", "info");
				return;
			}
			pi.appendEntry(ENTRY_TYPE, panel);
		},
	});

	// -- agent tool ----------------------------------------------------------

	const CalldiffParams = Type.Object({
		mode: StringEnum(["diff", "tree", "reach"] as const),
		from: Type.Optional(Type.String({ description: "Before ref (diff), or the ref to read (tree/reach). Default HEAD." })),
		to: Type.Optional(Type.String({ description: "After ref for diff. Default: working tree." })),
		entry: Type.Optional(
			Type.Array(Type.String(), { description: "Entrypoint symbols: functionName or ClassName.method." }),
		),
		file: Type.Optional(Type.String({ description: "Entrypoint file; expands to every exported symbol in it." })),
		target: Type.Optional(Type.String({ description: "Target symbol for mode=reach." })),
		paths: Type.Optional(Type.Array(Type.String(), { description: "Limit analysis to these path prefixes." })),
		maxDepth: Type.Optional(Type.Number({ description: "Max call-tree depth (default 12)." })),
	});

	pi.registerTool({
		name: "calldiff",
		label: "Calldiff",
		description:
			"Diff or inspect call stacks (who-calls-whom) using tree-sitter, across git refs. " +
			"mode=diff shows which callees appeared/disappeared under changed entrypoints (default HEAD vs working tree). " +
			"mode=tree prints the call tree for an entrypoint. " +
			"mode=reach lists every call path from an entrypoint to a target symbol. " +
			"Syntactic only: dynamic dispatch and callbacks do not resolve.",
		promptSnippet: "Diff or trace function call stacks across git refs (diff / tree / reach)",
		promptGuidelines: [
			"Use calldiff to verify that a refactor preserved call flow, or to trace whether one function can still reach another.",
			"Do not use calldiff for ordinary code reading; read and grep are cheaper.",
		],
		parameters: CalldiffParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!existsSync(join(ctx.cwd, ".git"))) {
				return {
					content: [{ type: "text", text: "calldiff requires a git repo (none found in the working directory)." }],
					details: { error: "no-git" },
				};
			}

			const mode = params.mode as Mode;
			if (mode === "reach" && !params.target) {
				return {
					content: [{ type: "text", text: "mode=reach requires `target` (the symbol to reach)." }],
					details: { error: "missing-target" },
				};
			}
			if (mode !== "diff" && !params.entry?.length && !params.file) {
				return {
					content: [{ type: "text", text: `mode=${mode} requires \`entry\` or \`file\`.` }],
					details: { error: "missing-entry" },
				};
			}

			const argv: string[] = [mode];
			if (mode === "diff") {
				if (params.from) argv.push(params.from);
				if (params.to) argv.push(params.to);
			} else if (params.from) {
				argv.push(params.from);
			}
			for (const entry of params.entry ?? []) argv.push("--entry", entry);
			if (params.file) argv.push("--file", params.file);
			if (params.target) argv.push("--to", params.target);
			if (params.maxDepth) argv.push("--max-depth", String(params.maxDepth));
			for (const path of params.paths ?? []) argv.push(path);

			const result = await run(ctx.cwd, argv, signal, TOOL_TIMEOUT_MS);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `calldiff failed: ${result.error}` }],
					details: { error: result.error },
				};
			}

			const text = formatForAgent(result.data);
			return {
				content: [{ type: "text", text }],
				details: { mode, argv, ms: result.ms, text },
			};
		},

		renderCall(args, theme) {
			const mode = typeof args.mode === "string" ? args.mode : "diff";
			const entry = Array.isArray(args.entry) ? args.entry.join(", ") : "";
			let text = theme.fg("toolTitle", theme.bold("calldiff ")) + theme.fg("muted", mode);
			if (entry) text += ` ${theme.fg("accent", entry)}`;
			if (typeof args.target === "string" && args.target) text += theme.fg("muted", ` → ${args.target}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { text?: string; error?: string } | undefined;
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const text = details?.text ?? "";
			const rendered = colorize(theme, text);
			if (expanded) return new Text(rendered, 0, 0);
			const lines = rendered.split("\n");
			const head = lines.slice(0, 12).join("\n");
			return new Text(
				lines.length > 12 ? `${head}\n${theme.fg("dim", `… ${lines.length - 12} more lines`)}` : head,
				0,
				0,
			);
		},
	});
}
