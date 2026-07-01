/**
 * workspace
 *
 * Manage jj (Jujutsu) workspaces, with optional herdr integration.
 *
 *   /workspace list              List jj workspaces for the current repo and
 *                                whether each is open in herdr.
 *   /workspace create <name> [rev]
 *                                Create a jj workspace under the configured
 *                                root, copy configured gitignored files into
 *                                it, and open it in herdr.
 *   /workspace switch [name]     Focus the herdr workspace for a jj workspace,
 *                                opening it if not already open. Prompts when
 *                                no name is given.
 *   /workspace delete [name]     Forget a jj workspace, delete its managed
 *                                directory, and close it in herdr. Prompts when
 *                                no name is given.
 *
 * Configuration lives under the top-level "workspaces" key in
 * ~/.pi/agent/settings.json:
 *
 *   {
 *     "workspaces": {
 *       "root": "~/.herdr/workspaces",
 *       "copyFiles": ["mise.local.toml"]
 *     }
 *   }
 *
 * Managed workspaces are created at <root>/<repo>/<name>, mirroring herdr's
 * ~/.herdr/worktrees/<repo>/<branch-slug> convention. jj workspaces have a .jj
 * dir but no .git dir, so tools that require .git (gh, prek) need extra care;
 * that is out of scope for these commands.
 */

import net from "node:net";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

interface WorkspaceConfig {
	/** Root directory for managed jj workspaces. Default ~/.herdr/workspaces. */
	root: string;
	/** Gitignored files (repo-relative) copied into new workspaces. */
	copyFiles: string[];
}

const DEFAULT_ROOT = "~/.herdr/workspaces";
const DEFAULT_COPY_FILES = ["mise.local.toml"];

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

/** Load the "workspaces" block from ~/.pi/agent/settings.json, with defaults. */
function loadConfig(): WorkspaceConfig {
	let root = DEFAULT_ROOT;
	let copyFiles = DEFAULT_COPY_FILES;
	try {
		const settingsPath = join(agentDir(), "settings.json");
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
				workspaces?: { root?: unknown; copyFiles?: unknown };
			};
			const ws = settings.workspaces;
			if (ws) {
				if (typeof ws.root === "string" && ws.root.trim()) root = ws.root.trim();
				if (Array.isArray(ws.copyFiles)) {
					copyFiles = ws.copyFiles.filter((f): f is string => typeof f === "string" && f.trim().length > 0);
				}
			}
		}
	} catch {
		// Ignore malformed settings and fall back to defaults.
	}
	return { root: expandTilde(root), copyFiles };
}

// ---------------------------------------------------------------------------
// shell / jj helpers
// ---------------------------------------------------------------------------

async function sh(pi: ExtensionAPI, cmd: string, args: string[], cwd?: string) {
	return pi.exec(cmd, args, cwd ? { cwd } : undefined);
}

async function jj(pi: ExtensionAPI, args: string[], cwd: string) {
	const res = await sh(pi, "jj", ["--color", "never", ...args], cwd);
	if (res.code !== 0) {
		throw new Error(`jj ${args.join(" ")}: ${res.stderr.trim() || res.stdout.trim()}`);
	}
	return res.stdout;
}

interface RepoInfo {
	/** Root of the workspace pi is currently running in. */
	workspaceRoot: string;
	/** Root of the repo's default (store-owning) workspace. */
	mainRoot: string;
	/** Repo grouping name used in the managed path layout. */
	repoName: string;
}

/**
 * Resolve the current workspace root and the repo's default workspace root.
 *
 * In a secondary workspace, .jj/repo is a file whose content points at the
 * store path (<mainRoot>/.jj/repo). In the default workspace it is a directory.
 */
async function resolveRepo(pi: ExtensionAPI, cwd: string): Promise<RepoInfo> {
	const workspaceRoot = (await jj(pi, ["workspace", "root"], cwd)).trim();
	let mainRoot = workspaceRoot;
	try {
		const repoPointer = join(workspaceRoot, ".jj", "repo");
		if (existsSync(repoPointer)) {
			const stat = readFileSync(repoPointer, "utf-8").trim();
			// A file pointer contains an absolute path to the store's repo dir.
			if (stat && isAbsolute(stat) && stat.includes(`${join(".jj", "repo")}`)) {
				// <mainRoot>/.jj/repo -> mainRoot
				mainRoot = dirname(dirname(stat));
			}
		}
	} catch {
		// .jj/repo is a directory (default workspace) -> readFileSync throws EISDIR.
	}
	return { workspaceRoot, mainRoot, repoName: basename(mainRoot) };
}

interface WorkspaceEntry {
	name: string;
	current: boolean;
	/** Managed directory (<root>/<repo>/<name>) or mainRoot for "default". */
	dir: string;
}

/** List jj workspaces for the repo. */
async function listWorkspaces(pi: ExtensionAPI, cfg: WorkspaceConfig, repo: RepoInfo, cwd: string): Promise<WorkspaceEntry[]> {
	const out = await jj(pi, ["workspace", "list"], cwd);
	const currentName = repo.workspaceRoot === repo.mainRoot ? "default" : basename(repo.workspaceRoot);
	const entries: WorkspaceEntry[] = [];
	for (const line of out.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		const m = t.match(/^([^:\s]+):/);
		if (!m) continue;
		const name = m[1];
		const dir = name === "default" ? repo.mainRoot : join(cfg.root, repo.repoName, name);
		entries.push({ name, current: name === currentName, dir });
	}
	return entries;
}

// ---------------------------------------------------------------------------
// herdr socket client (newline-delimited JSON over a unix socket)
// ---------------------------------------------------------------------------

function herdrSocketPath(): string {
	return process.env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock");
}

interface HerdrResult {
	ok: boolean;
	result?: Record<string, unknown>;
	error?: string;
}

/** Send a single request to herdr's socket. Never throws. */
function herdrRequest(method: string, params: Record<string, unknown>): Promise<HerdrResult> {
	return new Promise((resolve) => {
		const sockPath = herdrSocketPath();
		if (!existsSync(sockPath)) {
			resolve({ ok: false, error: "herdr is not running (socket not found)" });
			return;
		}
		const id = `pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		let buf = "";
		let settled = false;
		const finish = (r: HerdrResult) => {
			if (settled) return;
			settled = true;
			try {
				sock.destroy();
			} catch {}
			resolve(r);
		};
		const sock = net.createConnection(sockPath);
		const timer = setTimeout(() => finish({ ok: false, error: "herdr request timed out" }), 5000);
		sock.on("connect", () => {
			sock.write(`${JSON.stringify({ id, method, params })}\n`);
		});
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf-8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				try {
					const msg = JSON.parse(line) as { id?: string; result?: Record<string, unknown>; error?: { message?: string } };
					if (msg.id !== id) continue;
					clearTimeout(timer);
					if (msg.error) finish({ ok: false, error: msg.error.message || "herdr error" });
					else finish({ ok: true, result: msg.result ?? {} });
					return;
				} catch {
					// Ignore non-JSON lines.
				}
			}
		});
		sock.on("error", (e) => {
			clearTimeout(timer);
			finish({ ok: false, error: (e as Error).message });
		});
		sock.on("close", () => {
			clearTimeout(timer);
			finish({ ok: false, error: "herdr connection closed" });
		});
	});
}

interface HerdrWorkspace {
	id: string;
	cwd: string;
	label?: string;
}

/** Best-effort parse of workspace.list, tolerant of field-name variation. */
export function parseHerdrWorkspaces(result: Record<string, unknown> | undefined): HerdrWorkspace[] {
	if (!result) return [];
	const arr =
		(Array.isArray(result.workspaces) && result.workspaces) ||
		(Array.isArray(result.list) && result.list) ||
		(Array.isArray(result.items) && result.items) ||
		[];
	const out: HerdrWorkspace[] = [];
	for (const raw of arr as unknown[]) {
		if (!raw || typeof raw !== "object") continue;
		const o = raw as Record<string, unknown>;
		const id = o.id ?? o.workspace_id ?? o.workspaceId;
		const cwd = o.cwd ?? o.path ?? o.working_directory ?? o.workingDirectory;
		if (typeof id === "string" && typeof cwd === "string") {
			out.push({ id, cwd, label: typeof o.label === "string" ? o.label : undefined });
		}
	}
	return out;
}

async function herdrFindByCwd(dir: string): Promise<{ available: boolean; workspace?: HerdrWorkspace }> {
	const res = await herdrRequest("workspace.list", {});
	if (!res.ok) return { available: false };
	const match = parseHerdrWorkspaces(res.result).find((w) => w.cwd === dir);
	return { available: true, workspace: match };
}

// ---------------------------------------------------------------------------
// file copy
// ---------------------------------------------------------------------------

/** Copy configured gitignored files from the source into a new workspace. */
function copyConfiguredFiles(cfg: WorkspaceConfig, srcRoot: string, destRoot: string): { copied: string[]; skipped: string[] } {
	const copied: string[] = [];
	const skipped: string[] = [];
	for (const rel of cfg.copyFiles) {
		const src = join(srcRoot, rel);
		const dest = join(destRoot, rel);
		if (!existsSync(src)) {
			skipped.push(rel);
			continue;
		}
		if (existsSync(dest)) {
			skipped.push(rel);
			continue;
		}
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(src, dest);
		copied.push(rel);
	}
	return { copied, skipped };
}

// ---------------------------------------------------------------------------
// UI: single-select picker (cancellable)
// ---------------------------------------------------------------------------

async function pickWorkspace(ctx: ExtensionCommandContext, title: string, entries: WorkspaceEntry[]): Promise<WorkspaceEntry | null> {
	if (entries.length === 0) return null;
	if (ctx.mode !== "tui") return null;

	return ctx.ui.custom<WorkspaceEntry | null>((tui, theme, _kb, done) => {
		let index = Math.max(0, entries.findIndex((e) => !e.current));
		if (index < 0) index = 0;
		let cachedLines: string[] | undefined;
		const refresh = () => {
			cachedLines = undefined;
			tui.requestRender();
		};

		const render = (width: number): string[] => {
			if (cachedLines) return cachedLines;
			const w = Math.max(1, width);
			const lines: string[] = [];
			const add = (prefix: string, text: string) => {
				const pw = visibleWidth(prefix);
				const wrapped = wrapTextWithAnsi(text, Math.max(1, w - pw));
				const cont = " ".repeat(pw);
				wrapped.forEach((ln, i) => lines.push(`${i === 0 ? prefix : cont}${ln}`));
			};

			lines.push(theme.fg("accent", "─".repeat(w)));
			add(" ", theme.fg("text", theme.bold(title)));
			lines.push("");
			entries.forEach((e, i) => {
				const cur = i === index;
				const arrow = cur ? theme.fg("accent", ">") : " ";
				const tags: string[] = [];
				if (e.current) tags.push("current");
				const label = `${arrow} ${theme.fg(cur ? "accent" : "text", e.name)}${tags.length ? ` ${theme.fg("muted", `(${tags.join(", ")})`)}` : ""}`;
				add("", label);
			});
			lines.push("");
			add(" ", theme.fg("dim", "↑↓ move • enter confirm • esc cancel"));
			lines.push(theme.fg("accent", "─".repeat(w)));
			cachedLines = lines;
			return lines;
		};

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput: (data: string) => {
				if (matchesKey(data, Key.up)) {
					index = Math.max(0, index - 1);
					refresh();
				} else if (matchesKey(data, Key.down)) {
					index = Math.min(entries.length - 1, index + 1);
					refresh();
				} else if (matchesKey(data, Key.enter)) {
					done(entries[index]);
				} else if (matchesKey(data, Key.escape)) {
					done(null);
				}
			},
		};
	});
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

export function isValidName(name: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(name);
}

async function cmdList(pi: ExtensionAPI, ctx: ExtensionCommandContext, cfg: WorkspaceConfig) {
	const repo = await resolveRepo(pi, ctx.cwd);
	const entries = await listWorkspaces(pi, cfg, repo, ctx.cwd);
	const herdr = await herdrRequest("workspace.list", {});
	const herdrWs = herdr.ok ? parseHerdrWorkspaces(herdr.result) : [];
	const openByCwd = new Set(herdrWs.map((w) => w.cwd));

	const lines = [`jj workspaces (repo: ${repo.repoName}):`];
	for (const e of entries) {
		const marker = e.current ? "*" : " ";
		const open = openByCwd.has(e.dir) ? "  [open in herdr]" : "";
		lines.push(`${marker} ${e.name}${open}`);
	}
	if (!herdr.ok) lines.push("", `(herdr status unavailable: ${herdr.error})`);
	ctx.ui.notify(lines.join("\n"), "info");
}

/** Focus a workspace's herdr workspace, opening it if not already open. */
async function openInHerdr(ctx: ExtensionCommandContext, entry: WorkspaceEntry) {
	const found = await herdrFindByCwd(entry.dir);
	if (!found.available) {
		ctx.ui.notify(`herdr unavailable; workspace dir: ${entry.dir}`, "warning");
		return;
	}
	if (found.workspace) {
		const res = await herdrRequest("workspace.focus", { workspace_id: found.workspace.id });
		ctx.ui.notify(res.ok ? `Focused herdr workspace '${entry.name}'` : `herdr focus failed: ${res.error}`, res.ok ? "info" : "error");
	} else {
		const res = await herdrRequest("workspace.create", { cwd: entry.dir, label: entry.name });
		ctx.ui.notify(res.ok ? `Opened herdr workspace '${entry.name}'` : `herdr open failed: ${res.error}`, res.ok ? "info" : "error");
	}
}

/** Create a jj workspace, copy configured files, and open it in herdr. */
async function createWorkspace(pi: ExtensionAPI, ctx: ExtensionCommandContext, cfg: WorkspaceConfig, repo: RepoInfo, name: string, rev?: string) {
	if (!name) throw new Error("usage: /workspace create <name> [revision]");
	if (!isValidName(name)) throw new Error(`invalid workspace name '${name}' (allowed: letters, digits, . _ -)`);
	if (name === "default") throw new Error("'default' is reserved");

	const dest = join(cfg.root, repo.repoName, name);
	if (existsSync(dest)) throw new Error(`directory already exists: ${dest}`);

	mkdirSync(dirname(dest), { recursive: true });
	const addArgs = ["workspace", "add", "--name", name];
	if (rev) addArgs.push("-r", rev);
	addArgs.push(dest);
	await jj(pi, addArgs, ctx.cwd);

	const { copied } = copyConfiguredFiles(cfg, repo.mainRoot, dest);

	const summary = [`Created jj workspace '${name}' at ${dest}`];
	if (copied.length) summary.push(`Copied: ${copied.join(", ")}`);

	const herdr = await herdrRequest("workspace.create", { cwd: dest, label: name });
	summary.push(herdr.ok ? "Opened in herdr." : `herdr not opened: ${herdr.error}`);

	ctx.ui.notify(summary.join("\n"), "info");
}

/** Forget one or more jj workspaces, remove managed dirs, and close them in herdr. */
async function deleteWorkspaces(pi: ExtensionAPI, ctx: ExtensionCommandContext, cfg: WorkspaceConfig, repo: RepoInfo, targets: WorkspaceEntry[]) {
	const managedPrefix = join(cfg.root, repo.repoName);
	const summary: string[] = [];
	for (const t of targets) {
		if (t.name === "default" || t.current) {
			summary.push(`Skipped ${t.current ? "current" : "default"} workspace '${t.name}'`);
			continue;
		}
		try {
			await jj(pi, ["workspace", "forget", t.name], ctx.cwd);
			summary.push(`Forgot '${t.name}'`);
			if (t.dir.startsWith(managedPrefix) && existsSync(t.dir)) {
				const rm = await sh(pi, "rm", ["-rf", t.dir]);
				summary.push(rm.code === 0 ? `  removed ${t.dir}` : `  failed to remove dir: ${rm.stderr.trim()}`);
			} else {
				summary.push(`  left directory in place: ${t.dir}`);
			}
			const found = await herdrFindByCwd(t.dir);
			if (found.available && found.workspace) {
				const res = await herdrRequest("workspace.close", { workspace_id: found.workspace.id });
				summary.push(res.ok ? "  closed in herdr" : `  herdr close failed: ${res.error}`);
			}
		} catch (e) {
			summary.push(`Failed to delete '${t.name}': ${(e as Error).message}`);
		}
	}
	ctx.ui.notify(summary.join("\n"), "info");
}

async function cmdCreate(pi: ExtensionAPI, ctx: ExtensionCommandContext, cfg: WorkspaceConfig, rest: string[]) {
	const repo = await resolveRepo(pi, ctx.cwd);
	await createWorkspace(pi, ctx, cfg, repo, rest[0], rest[1]);
}

async function cmdSwitch(pi: ExtensionAPI, ctx: ExtensionCommandContext, cfg: WorkspaceConfig, rest: string[]) {
	const repo = await resolveRepo(pi, ctx.cwd);
	const entries = await listWorkspaces(pi, cfg, repo, ctx.cwd);

	let target = rest[0] ? entries.find((e) => e.name === rest[0]) : undefined;
	if (rest[0] && !target) throw new Error(`no such workspace: ${rest[0]}`);
	if (!target) {
		const picked = await pickWorkspace(ctx, "Switch to workspace", entries);
		if (!picked) {
			ctx.ui.notify("switch cancelled", "info");
			return;
		}
		target = picked;
	}
	await openInHerdr(ctx, target);
}

async function cmdDelete(pi: ExtensionAPI, ctx: ExtensionCommandContext, cfg: WorkspaceConfig, rest: string[]) {
	const repo = await resolveRepo(pi, ctx.cwd);
	const entries = await listWorkspaces(pi, cfg, repo, ctx.cwd);
	const deletable = entries.filter((e) => e.name !== "default" && !e.current);

	let target = rest[0] ? entries.find((e) => e.name === rest[0]) : undefined;
	if (rest[0] && !target) throw new Error(`no such workspace: ${rest[0]}`);
	if (target && (target.name === "default" || target.current)) {
		throw new Error(`refusing to delete ${target.current ? "the current" : "the default"} workspace`);
	}
	if (!target) {
		if (deletable.length === 0) {
			ctx.ui.notify("no deletable workspaces", "info");
			return;
		}
		const picked = await pickWorkspace(ctx, "Delete workspace", deletable);
		if (!picked) {
			ctx.ui.notify("delete cancelled", "info");
			return;
		}
		target = picked;
	}

	if (ctx.mode === "tui") {
		const ok = await ctx.ui.confirm("Delete workspace", `Forget '${target.name}' and remove ${target.dir}?`);
		if (!ok) {
			ctx.ui.notify("delete cancelled", "info");
			return;
		}
	}
	await deleteWorkspaces(pi, ctx, cfg, repo, [target]);
}

// ---------------------------------------------------------------------------
// interactive dashboard (shown when /workspace is called with no arguments)
// ---------------------------------------------------------------------------

type MenuAction =
	| { kind: "switch"; entry: WorkspaceEntry }
	| { kind: "create" }
	| { kind: "delete"; entries: WorkspaceEntry[] };

async function workspaceMenu(ctx: ExtensionCommandContext, entries: WorkspaceEntry[], openDirs: Set<string>): Promise<MenuAction | null> {
	if (ctx.mode !== "tui") return null;

	return ctx.ui.custom<MenuAction | null>((tui, theme, _kb, done) => {
		let index = 0;
		const selected = entries.map(() => false);
		const canDelete = (e: WorkspaceEntry) => e.name !== "default" && !e.current;
		let cachedLines: string[] | undefined;
		const refresh = () => {
			cachedLines = undefined;
			tui.requestRender();
		};

		const render = (width: number): string[] => {
			if (cachedLines) return cachedLines;
			const w = Math.max(1, width);
			const lines: string[] = [];
			const add = (prefix: string, text: string) => {
				const pw = visibleWidth(prefix);
				const wrapped = wrapTextWithAnsi(text, Math.max(1, w - pw));
				const cont = " ".repeat(pw);
				wrapped.forEach((ln, i) => lines.push(`${i === 0 ? prefix : cont}${ln}`));
			};

			lines.push(theme.fg("accent", "─".repeat(w)));
			add(" ", theme.fg("text", theme.bold(`jj workspaces (${entries.length})`)));
			lines.push("");
			entries.forEach((e, i) => {
				const cur = i === index;
				const arrow = cur ? theme.fg("accent", ">") : " ";
				const box = canDelete(e) ? (selected[i] ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]")) : "   ";
				const tags: string[] = [];
				if (e.current) tags.push("current");
				if (openDirs.has(e.dir)) tags.push("open");
				const tagStr = tags.length ? ` ${theme.fg("muted", `(${tags.join(", ")})`)}` : "";
				add("", `${arrow} ${box} ${theme.fg(cur ? "accent" : "text", e.name)}${tagStr}`);
			});
			lines.push("");
			add(" ", theme.fg("dim", "↑↓ move • space select • enter switch • c create • d delete • esc cancel"));
			lines.push(theme.fg("accent", "─".repeat(w)));
			cachedLines = lines;
			return lines;
		};

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput: (data: string) => {
				if (matchesKey(data, Key.up)) {
					index = Math.max(0, index - 1);
					refresh();
				} else if (matchesKey(data, Key.down)) {
					index = Math.min(entries.length - 1, index + 1);
					refresh();
				} else if (data === " ") {
					if (canDelete(entries[index])) {
						selected[index] = !selected[index];
						refresh();
					}
				} else if (matchesKey(data, Key.enter)) {
					done({ kind: "switch", entry: entries[index] });
				} else if (data === "c" || data === "C" || data === "n" || data === "N") {
					done({ kind: "create" });
				} else if (data === "d" || data === "D") {
					const chosen = entries.filter((e, i) => selected[i] && canDelete(e));
					const list = chosen.length > 0 ? chosen : canDelete(entries[index]) ? [entries[index]] : [];
					if (list.length > 0) done({ kind: "delete", entries: list });
				} else if (matchesKey(data, Key.escape)) {
					done(null);
				}
			},
		};
	});
}

async function cmdMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext, cfg: WorkspaceConfig) {
	if (ctx.mode !== "tui") {
		await cmdList(pi, ctx, cfg);
		return;
	}
	const repo = await resolveRepo(pi, ctx.cwd);
	const entries = await listWorkspaces(pi, cfg, repo, ctx.cwd);
	const herdr = await herdrRequest("workspace.list", {});
	const openDirs = new Set(herdr.ok ? parseHerdrWorkspaces(herdr.result).map((w) => w.cwd) : []);

	const action = await workspaceMenu(ctx, entries, openDirs);
	if (!action) return;

	if (action.kind === "switch") {
		await openInHerdr(ctx, action.entry);
		return;
	}
	if (action.kind === "create") {
		const name = await ctx.ui.input("New workspace name", "my-workspace");
		if (!name || !name.trim()) {
			ctx.ui.notify("create cancelled", "info");
			return;
		}
		await createWorkspace(pi, ctx, cfg, repo, name.trim());
		return;
	}
	// delete
	const names = action.entries.map((e) => e.name).join(", ");
	const ok = await ctx.ui.confirm("Delete workspaces", `Forget and remove: ${names}?`);
	if (!ok) {
		ctx.ui.notify("delete cancelled", "info");
		return;
	}
	await deleteWorkspaces(pi, ctx, cfg, repo, action.entries);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

const SUBCOMMANDS = ["list", "create", "switch", "delete"] as const;

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("workspace", {
		description: "Manage jj workspaces (list/create/switch/delete) with herdr integration",
		getArgumentCompletions: (prefix: string) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				return SUBCOMMANDS.filter((s) => s.startsWith(parts[0] ?? "")).map((s) => ({ value: s, label: s }));
			}
			return null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const sub = (parts[0] ?? "").toLowerCase();
				const rest = parts.slice(1);
				const cfg = loadConfig();
				switch (sub) {
					case "":
						// No arguments: show the interactive dashboard.
						await cmdMenu(pi, ctx, cfg);
						break;
					case "list":
					case "ls":
						await cmdList(pi, ctx, cfg);
						break;
					case "create":
					case "new":
						await cmdCreate(pi, ctx, cfg, rest);
						break;
					case "switch":
					case "sw":
						await cmdSwitch(pi, ctx, cfg, rest);
						break;
					case "delete":
					case "rm":
						await cmdDelete(pi, ctx, cfg, rest);
						break;
					default:
						ctx.ui.notify(`unknown subcommand '${sub}'. Use: ${SUBCOMMANDS.join(", ")}`, "error");
				}
			} catch (e) {
				ctx.ui.notify(`workspace: ${(e as Error).message}`, "error");
			}
		},
	});
}
