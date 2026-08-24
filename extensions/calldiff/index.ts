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
 * Output shaping (the CLI's own ascii is deliberately not used):
 *   - if/switch scaffolding is dropped and its children reparented.
 *   - Calls into stdlib / dependencies are dropped, verified with a single
 *     ripgrep for definitions across the whole candidate set, cached per turn.
 *     When verification is unavailable nothing is dropped.
 *   - Unchanged siblings collapse to "… N unchanged", keeping two on each side
 *     of a change.
 *   - Added subtrees, which are added all the way down by construction, render
 *     two levels then summarise the rest.
 *   - The panel groups entrypoints by their definition file, and keeps a second,
 *     unfolded rendering of every entrypoint that ctrl+o swaps in.
 *
 * Requirements:
 *   - calldiff, resolved in this order: the copy bundled with this package
 *     (pinned by our lockfile, no network), then PATH, then a version-pinned
 *     npx fallback. It stays a per-call subprocess: tree-sitter is a native
 *     addon, so a crash must not be able to take pi down with it.
 *   - A git repo. jj works only when the repo is colocated (`.git` present),
 *     because calldiff reads refs via `git show`.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { DiffNode, DiffStatus } from "calldiff";

const ENTRY_TYPE = "calldiff";
/** Entrypoints rendered in the collapsed panel; ctrl+o reveals the rest. */
const PANEL_TREE_LIMIT = 3;
const PANEL_TIMEOUT_MS = 20_000;
const TOOL_TIMEOUT_MS = 30_000;
const TOOL_CHAR_BUDGET = 8_000;
const PANEL_CHAR_BUDGET = 20_000;
/** Pinned so the npx fallback cannot pull a newer, differently-shaped CLI. */
const CALLDIFF_FALLBACK_VERSION = "0.5.0";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

type Mode = "diff" | "tree" | "reach";

/**
 * Shaping runs over `diff` nodes, which carry `status`, and over `tree` nodes,
 * which do not, on JSON we did not construct. Hence every field optional. The
 * field names and types come from the package so they cannot drift silently.
 */
export type CalldiffNode = Partial<Omit<DiffNode, "children">> & {
	children?: CalldiffNode[];
};

interface CalldiffTree {
	entry?: string;
	ascii?: string;
	tree?: CalldiffNode;
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

/** One entrypoint in the panel, with both renderings precomputed. */
export interface PanelEntry {
	entry: string;
	/** Definition site of the entrypoint; the panel groups on it. */
	file?: string;
	line?: number;
	/** Collapsed body: unchanged siblings folded, added subtrees capped. */
	compact: string;
	/** Expanded body (ctrl+o): every sibling, every level. */
	full: string;
	added: number;
	removed: number;
}

/** Data persisted for the TUI-only panel entry. */
interface PanelData {
	from: string;
	to: string;
	entries?: PanelEntry[];
	ms: number;
	/** Shape recorded by sessions from before grouping landed. */
	shown?: { entry: string; ascii: string }[];
	hidden?: number;
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

/**
 * Resolve the CLI shipped with this package. Preferred over PATH and npx: the
 * version is pinned by our lockfile, so calldiff cannot change its JSON shape
 * under us between two runs, and there is no network hit on first use.
 */
function bundledBin(): Bin | null {
	try {
		// calldiff's `exports` map only defines "." under the `import` condition, so
		// neither `require.resolve("calldiff")` nor the `calldiff/package.json`
		// subpath resolves. ESM resolution is the only one that works here.
		const entry = fileURLToPath(import.meta.resolve("calldiff"));
		const cli = join(dirname(entry), "cli.js");
		if (!existsSync(cli)) return null;
		let version = "unknown";
		try {
			const manifest = join(dirname(entry), "..", "package.json");
			version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version ?? version;
		} catch {
			// Label only; a missing manifest is not worth failing over.
		}
		return { cmd: process.execPath, args: [cli], label: `calldiff ${version} (bundled)` };
	} catch {
		// Optional dependency: a failed native build leaves it unresolvable.
		return null;
	}
}

async function resolveBin(pi: ExtensionAPI): Promise<Bin> {
	if (binCache) return binCache;

	const bundled = bundledBin();
	if (bundled) {
		binCache = bundled;
		return binCache;
	}

	let found = "";
	try {
		const which = await pi.exec("sh", ["-lc", "command -v calldiff"], { timeout: 5_000 });
		if (which.code === 0) found = which.stdout.trim().split("\n")[0]?.trim() ?? "";
	} catch {
		found = "";
	}
	binCache = found
		? { cmd: found, args: [], label: found }
		: {
				cmd: "npx",
				args: ["-y", `calldiff@${CALLDIFF_FALLBACK_VERSION}`],
				label: `npx calldiff@${CALLDIFF_FALLBACK_VERSION} (not installed locally)`,
			};
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

/** Unchanged siblings kept on each side of a change, git-diff style context. */
const CONTEXT_SIBLINGS = 2;
/** Levels rendered under an added/removed node before the rest is summarised. */
const ADDED_DEPTH_CAP = 2;
/** Budget for the single definition-verification ripgrep. */
const VERIFY_TIMEOUT_MS = 2_000;
/** Above this many candidates the alternation regex stops paying off. */
const VERIFY_MAX_SYMBOLS = 100;

type NodeStatus = DiffStatus;

/** Node after shaping: branches stripped, externals dropped, subtrees capped. */
export interface ShapedNode {
	label: string;
	status: NodeStatus;
	children: ShapedNode[];
	/** A summary line ("… 3 unchanged") rather than a real call. */
	ghost?: boolean;
}

function nodeStatus(node: CalldiffNode): NodeStatus {
	return node.status === "added" || node.status === "removed" ? node.status : "same";
}

/** Summary line. Inherits the parent status so an added subtree stays visually one block. */
function ghost(label: string, status: NodeStatus = "same"): ShapedNode {
	return { label, status, children: [], ghost: true };
}

function clip(text: string, budget: number): string {
	if (text.length <= budget) return text;
	return `${text.slice(0, budget)}\n… truncated (${text.length - budget} more chars)`;
}

// -- shaping ----------------------------------------------------------------

/**
 * `kind: "branch"` nodes are if/switch scaffolding, not calls. Drop them and
 * reparent their children so a real call nested in a branch survives.
 */
function stripBranches(nodes: CalldiffNode[]): CalldiffNode[] {
	const out: CalldiffNode[] = [];
	for (const node of nodes) {
		const children = stripBranches(node.children ?? []);
		if (node.kind === "branch") out.push(...children);
		else out.push({ ...node, children });
	}
	return out;
}

/** Last dotted segment: `sb.WriteString` -> `WriteString`, `fmt.Println` -> `Println`. */
function symbolName(node: CalldiffNode): string {
	const key = node.key ?? node.label ?? "";
	const parts = key.split(".");
	return parts[parts.length - 1] ?? key;
}

function escapeRe(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Childless nodes are either repo leaf functions or calls into stdlib / deps
 * whose bodies calldiff cannot see. Only those need verification.
 */
function collectCandidates(nodes: CalldiffNode[], into: Set<string>): void {
	for (const node of nodes) {
		const children = node.children ?? [];
		if (children.length === 0) {
			const name = symbolName(node);
			if (/^[A-Za-z_]\w*$/.test(name)) into.add(name);
		} else collectCandidates(children, into);
	}
}

/** `symbol -> defined in this repo`, valid until the working copy changes. */
const definitionCache = new Map<string, boolean>();

function resetDefinitionCache(): void {
	definitionCache.clear();
}

function definitionPatterns(names: string[]): string[] {
	const alt = names.map(escapeRe).join("|");
	const mods = "(?:export|public|private|protected|static|async|open|override)\\s+";
	return [
		// Go / TS / Python / Rust declarations, including Go method receivers.
		`^\\s*(?:${mods})*(?:func|function|def|fn)\\s+(?:\\([^)]*\\)\\s*)?(?:${alt})\\b`,
		// `const Name = () => …` and friends.
		`^\\s*(?:export\\s+)?(?:const|let|var)\\s+(?:${alt})\\s*[:=]`,
		// Class / object members: `Name(args) {`.
		`^\\s*(?:${mods})*(?:${alt})\\s*\\(`,
	];
}

/**
 * Which of `names` have a definition in the repo, resolved with one ripgrep for
 * the whole candidate set. Biased toward false positives: an unsure symbol is
 * kept, never hidden. Returns null when verification is unavailable (no rg,
 * timeout, too many candidates) so callers keep every leaf instead of guessing.
 */
async function verifyDefined(
	pi: ExtensionAPI,
	cwd: string,
	names: string[],
	signal: AbortSignal | undefined,
): Promise<Set<string> | null> {
	const unknown = names.filter((name) => !definitionCache.has(name));
	if (unknown.length > VERIFY_MAX_SYMBOLS) return null;
	if (unknown.length > 0) {
		const args = ["--no-messages", "--no-filename", "--no-line-number", "-o"];
		for (const pattern of definitionPatterns(unknown)) args.push("-e", pattern);
		let stdout = "";
		try {
			const res = await pi.exec("rg", args, { cwd, signal, timeout: VERIFY_TIMEOUT_MS });
			if (res.killed) return null;
			// rg exits 1 when nothing matched, which is a valid "none defined".
			if (res.code !== 0 && res.code !== 1) return null;
			stdout = res.stdout;
		} catch {
			return null;
		}
		for (const name of unknown) {
			definitionCache.set(name, new RegExp(`\\b${escapeRe(name)}\\b`).test(stdout));
		}
	}
	const defined = new Set<string>();
	for (const name of names) if (definitionCache.get(name)) defined.add(name);
	return defined;
}

function hasChangeIn(node: CalldiffNode): boolean {
	if (nodeStatus(node) !== "same") return true;
	return (node.children ?? []).some(hasChangeIn);
}

function countDescendants(nodes: CalldiffNode[]): number {
	let total = 0;
	for (const node of nodes) total += 1 + countDescendants(node.children ?? []);
	return total;
}

export interface ShapeOpts {
	/** Null means "could not verify", in which case no leaf is dropped. */
	defined: Set<string> | null;
	/** Collapse unchanged siblings. Only meaningful for mode=diff. */
	collapse: boolean;
	/**
	 * Levels rendered under an added/removed node before the rest is summarised.
	 * Null renders the whole subtree; undefined uses ADDED_DEPTH_CAP.
	 */
	depthCap?: number | null;
}

function shapeChildren(
	nodes: CalldiffNode[],
	addedDepth: number,
	opts: ShapeOpts,
	parentStatus: NodeStatus,
): ShapedNode[] {
	// 1. Drop calls into stdlib / dependencies. A verified-external leaf is kept
	//    only when it is the change itself and the parent does not already say so.
	const kept = nodes.filter((node) => {
		if ((node.children ?? []).length > 0) return true;
		if (!opts.defined || opts.defined.has(symbolName(node))) return true;
		return nodeStatus(node) !== "same" && parentStatus === "same";
	});

	// 2. Keep changed siblings plus CONTEXT_SIBLINGS unchanged ones either side.
	const changed = kept.map(hasChangeIn);
	const keepIdx = new Set<number>();
	if (!opts.collapse || !changed.some(Boolean)) {
		kept.forEach((_, i) => keepIdx.add(i));
	} else {
		changed.forEach((flag, i) => {
			if (!flag) return;
			const lo = Math.max(0, i - CONTEXT_SIBLINGS);
			const hi = Math.min(kept.length - 1, i + CONTEXT_SIBLINGS);
			for (let j = lo; j <= hi; j++) keepIdx.add(j);
		});
	}

	const out: ShapedNode[] = [];
	let run = 0;
	const flush = () => {
		if (run > 0) out.push(ghost(`… ${run} unchanged`));
		run = 0;
	};
	for (let i = 0; i < kept.length; i++) {
		const node = kept[i];
		if (!node) continue;
		if (!keepIdx.has(i)) {
			run++;
			continue;
		}
		flush();
		out.push(shapeNode(node, addedDepth, opts, changed[i] ?? false));
	}
	flush();
	return out;
}

function shapeNode(node: CalldiffNode, addedDepth: number, opts: ShapeOpts, changed: boolean): ShapedNode {
	const status = nodeStatus(node);
	const children = node.children ?? [];
	const label = node.label ?? node.key ?? "(unknown)";

	// An unchanged node kept only for context carries no signal below it.
	if (opts.collapse && !changed) return { label, status, children: [] };

	// Everything under an added node is added too, which is how a one-line edit
	// turns into a twenty-line subtree. Render a few levels, then summarise.
	const depth = status === "same" ? 0 : addedDepth + 1;
	const cap = opts.depthCap === undefined ? ADDED_DEPTH_CAP : opts.depthCap;
	if (cap !== null && depth > cap) {
		const hidden = countDescendants(children);
		return { label, status, children: hidden > 0 ? [ghost(`… +${hidden} more`, status)] : [] };
	}

	return { label, status, children: shapeChildren(children, depth, opts, status) };
}

export function shapeTree(root: CalldiffNode, opts: ShapeOpts): ShapedNode {
	const stripped = stripBranches([root])[0] ?? root;
	return shapeNode(stripped, 0, opts, hasChangeIn(stripped));
}

// -- rendering --------------------------------------------------------------

function markerFor(status: NodeStatus): string {
	if (status === "added") return "+";
	if (status === "removed") return "-";
	return " ";
}

export function renderShaped(root: ShapedNode): string {
	const lines = [`${markerFor(root.status)} ${root.label}`];
	const walk = (nodes: ShapedNode[], prefix: string): void => {
		nodes.forEach((node, i) => {
			const last = i === nodes.length - 1;
			lines.push(`${markerFor(node.status)} ${prefix}${last ? "└─ " : "├─ "}${node.label}`);
			if (node.children.length > 0) walk(node.children, `${prefix}${last ? "   " : "│  "}`);
		});
	};
	walk(root.children, "");
	return lines.join("\n");
}

export function shapedHasChange(node: ShapedNode): boolean {
	if (node.status !== "same") return true;
	return node.children.some(shapedHasChange);
}

/** Fallback for payloads that carry only the CLI's pre-rendered ascii. */
function hasAsciiChange(ascii: string): boolean {
	return ascii.split("\n").some((line) => line.startsWith("+") || line.startsWith("-"));
}

// -- entry points -----------------------------------------------------------

/**
 * Turns a calldiff payload into one shaped ascii block per entrypoint. Shaping
 * happens on the structured `tree`; the CLI's own ascii is only a fallback.
 */
/** Real (non-ghost) added/removed nodes, used for the per-file counters. */
function countStatuses(node: ShapedNode, acc: { added: number; removed: number }): void {
	if (!node.ghost) {
		if (node.status === "added") acc.added++;
		else if (node.status === "removed") acc.removed++;
	}
	for (const child of node.children) countStatuses(child, acc);
}

function asciiCounts(ascii: string): { added: number; removed: number } {
	const acc = { added: 0, removed: 0 };
	for (const line of ascii.split("\n")) {
		if (line.startsWith("+")) acc.added++;
		else if (line.startsWith("-")) acc.removed++;
	}
	return acc;
}

async function shapeEntries(
	pi: ExtensionAPI,
	cwd: string,
	data: CalldiffResult,
	signal: AbortSignal | undefined,
	requireChange: boolean,
): Promise<PanelEntry[]> {
	const trees = Array.isArray(data.trees) ? data.trees : [];
	const roots = trees
		.map((tree) => ({
			entry: typeof tree.entry === "string" ? tree.entry : "(unknown)",
			node: tree.tree,
			ascii: typeof tree.ascii === "string" ? tree.ascii.trimEnd() : "",
			// Root nodes carry their definition site, which is what the panel groups on.
			file: typeof tree.tree?.file === "string" ? tree.tree.file : undefined,
			line: typeof tree.tree?.line === "number" ? tree.tree.line : undefined,
		}))
		.filter((item) => item.node || item.ascii);

	// One ripgrep for every candidate across every tree, not one per node.
	const candidates = new Set<string>();
	for (const item of roots) if (item.node) collectCandidates([item.node], candidates);
	const defined = candidates.size > 0 ? await verifyDefined(pi, cwd, [...candidates], signal) : new Set<string>();
	const compactOpts: ShapeOpts = { defined, collapse: requireChange };
	/** What ctrl+o reveals: nothing folded, nothing capped. */
	const fullOpts: ShapeOpts = { defined, collapse: false, depthCap: null };

	const out: PanelEntry[] = [];
	for (const item of roots) {
		if (!item.node) {
			if (!requireChange || hasAsciiChange(item.ascii)) {
				out.push({
					entry: item.entry,
					file: item.file,
					line: item.line,
					compact: item.ascii,
					full: item.ascii,
					...asciiCounts(item.ascii),
				});
			}
			continue;
		}
		const compact = shapeTree(item.node, compactOpts);
		if (requireChange && !shapedHasChange(compact)) continue;
		const full = compactOpts.collapse ? shapeTree(item.node, fullOpts) : compact;
		const counts = { added: 0, removed: 0 };
		countStatuses(full, counts);
		out.push({
			entry: item.entry,
			file: item.file,
			line: item.line,
			compact: renderShaped(compact),
			full: renderShaped(full),
			...counts,
		});
	}
	return out;
}

export interface FileGroup {
	file: string;
	entries: PanelEntry[];
	added: number;
	removed: number;
}

/** Group entrypoints by definition file, preserving calldiff's ordering. */
export function groupByFile(entries: PanelEntry[]): FileGroup[] {
	const groups = new Map<string, FileGroup>();
	for (const entry of entries) {
		const file = entry.file && entry.file.length > 0 ? entry.file : "(unknown file)";
		let group = groups.get(file);
		if (!group) {
			group = { file, entries: [], added: 0, removed: 0 };
			groups.set(file, group);
		}
		group.entries.push(entry);
		group.added += entry.added;
		group.removed += entry.removed;
	}
	return [...groups.values()];
}

/**
 * Compact text for the LLM. The nested `tree` objects duplicate everything the
 * ascii already says at several times the token cost, so only ascii is kept.
 */
function formatForAgent(data: CalldiffResult, entries: PanelEntry[], variant: "compact" | "full" = "compact"): string {
	const mode = data.mode ?? "diff";
	const header =
		mode === "diff" ? `calldiff ${mode} ${data.from ?? "HEAD"} -> ${data.to ?? "working tree"}` : `calldiff ${mode}`;

	if (Array.isArray(data.paths)) {
		if (data.paths.length === 0) return `${header}\n\nNo call paths found.`;
		return clip(`${header}\n\n${JSON.stringify(data.paths, null, 1)}`, TOOL_CHAR_BUDGET);
	}

	if (entries.length === 0) {
		return mode === "diff"
			? `${header}\n\nNo call-flow change detected. Do not retry with different arguments; the edits did not alter the call graph.`
			: `${header}\n\nNo call tree produced for the requested entrypoint.`;
	}

	// Grouped by file so the agent sees where each entrypoint lives, not just its name.
	const body = groupByFile(entries)
		.map((group) => {
			const trees = group.entries
				.map((entry) => `### ${entry.entry}${entry.line ? `:${entry.line}` : ""}\n${entry[variant]}`)
				.join("\n\n");
			return `## ${group.file}\n${trees}`;
		})
		.join("\n\n");
	return clip(`${header}\n\n${body}`, TOOL_CHAR_BUDGET);
}

function toPanelData(data: CalldiffResult, entries: PanelEntry[], ms: number): PanelData | null {
	if (entries.length === 0) return null;
	// Every entrypoint is persisted; what to show is decided at render time so
	// ctrl+o can reveal the ones the collapsed view left out.
	return {
		from: data.from ?? "HEAD",
		to: data.to ?? "working tree",
		entries,
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

/** Entries for a panel, tolerating the pre-grouping persisted shape. */
function panelEntries(data: PanelData): PanelEntry[] {
	if (Array.isArray(data.entries)) return data.entries;
	return (data.shown ?? []).map((entry) => ({
		entry: entry.entry,
		compact: entry.ascii,
		full: entry.ascii,
		...asciiCounts(entry.ascii),
	}));
}

/** First line (the entrypoint itself) and the rest of the tree. */
function splitTree(ascii: string): { root: string; body: string } {
	const lines = ascii.split("\n");
	return { root: lines[0] ?? "", body: lines.slice(1).join("\n") };
}

/** Indent under the file header without moving the +/- gutter. */
function indentTree(ascii: string): string {
	return ascii
		.split("\n")
		.map((line) => `${line.slice(0, 2)}    ${line.slice(2)}`)
		.join("\n");
}

function stats(theme: Theme, added: number, removed: number): string {
	const parts: string[] = [];
	if (added > 0) parts.push(theme.fg("success", `+${added}`));
	if (removed > 0) parts.push(theme.fg("error", `-${removed}`));
	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/**
 * Collapsed: file headers plus the first few entrypoints, each folded. Expanded
 * (ctrl+o): every entrypoint, every sibling, every level.
 */
function renderPanel(theme: Theme, data: PanelData, expanded: boolean): string {
	const entries = panelEntries(data);
	const groups = groupByFile(entries);
	const head =
		theme.fg("toolTitle", theme.bold("calldiff ")) +
		theme.fg("muted", `${data.from} → ${data.to}`) +
		theme.fg(
			"dim",
			` · ${entries.length} entrypoint${entries.length === 1 ? "" : "s"} in ${groups.length} file${groups.length === 1 ? "" : "s"} · ${data.ms}ms`,
		);

	const blocks: string[] = [];
	let shown = 0;
	let hidden = 0;
	for (const group of groups) {
		const room = expanded ? group.entries.length : Math.max(0, Math.max(PANEL_TREE_LIMIT, 1) - shown);
		const visible = group.entries.slice(0, room);
		hidden += group.entries.length - visible.length;
		if (visible.length === 0) continue;
		shown += visible.length;

		const lines = [
			theme.fg("toolTitle", theme.bold(group.file)) + stats(theme, group.added, group.removed),
		];
		for (const entry of visible) {
			const { root, body } = splitTree(expanded ? entry.full : entry.compact);
			const marker = root.slice(0, 1);
			const label = root.slice(2) || entry.entry;
			const color = marker === "+" ? "success" : marker === "-" ? "error" : "accent";
			lines.push(
				`${marker === "+" || marker === "-" ? marker : " "}  ${theme.fg(color, label)}` +
					(entry.line ? theme.fg("dim", `:${entry.line}`) : ""),
			);
			if (body) lines.push(colorize(theme, indentTree(body)));
		}
		blocks.push(lines.join("\n"));
	}

	let body = blocks.join("\n\n");
	if (!expanded) body = clip(body, PANEL_CHAR_BUDGET);

	const parts = [head, body];
	if (hidden > 0) {
		parts.push(theme.fg("dim", `… ${hidden} more changed entrypoint(s) · ctrl+o to expand`));
	} else if (!expanded && entries.some((entry) => entry.compact !== entry.full)) {
		parts.push(theme.fg("dim", "ctrl+o to expand"));
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
		const entries = await shapeEntries(pi, cwd, result.data, signal, true);
		const panel = toPanelData(result.data, entries, result.ms);
		if (panel) pi.appendEntry(ENTRY_TYPE, panel);
		return panel;
	}

	// -- TUI-only panel ------------------------------------------------------

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data as PanelData | undefined;
		if (!data || panelEntries(data).length === 0) return new Text("", 0, 0);
		return new Text(renderPanel(theme, data, expanded), 1, 0);
	});

	pi.on("agent_start", async (_event, ctx) => {
		turnCache = null;
		// Definitions can move between turns; the cache is only valid within one.
		resetDefinitionCache();
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
			const entries = await shapeEntries(pi, ctx.cwd, result.data, ctx.signal, true);
			const panel = toPanelData(result.data, entries, result.ms);
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

			const entries = await shapeEntries(pi, ctx.cwd, result.data, signal, mode === "diff");
			const text = formatForAgent(result.data, entries);
			const fullText = formatForAgent(result.data, entries, "full");
			return {
				content: [{ type: "text", text }],
				details: { mode, argv, ms: result.ms, text, fullText },
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
			const details = result.details as { text?: string; fullText?: string; error?: string } | undefined;
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const text = (expanded ? (details?.fullText ?? details?.text) : details?.text) ?? "";
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
