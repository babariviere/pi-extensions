/**
 * /context
 *
 * Small TUI view showing what's loaded/available:
 * - extensions (best-effort from registered extension slash commands)
 * - skills
 * - project context files (AGENTS.md / CLAUDE.md)
 * - current context window usage + session totals (tokens/cost)
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	BuildSystemPromptOptions,
	Theme,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, isReadToolResult } from "@earendil-works/pi-coding-agent";
import { Container, Key, Text, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";
import { sumAccountedUsage } from "../shared/usage-accounting.ts";

function formatUsd(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(4)}`;
}

function estimateTokens(text: string): number {
	// Deliberately fuzzy (good enough for “how big-ish is this”).
	return Math.max(0, Math.ceil(text.length / 4));
}

function normalizeReadPath(inputPath: string, cwd: string): string {
	// Similar to pi's resolveToCwd/resolveReadPath, but simplified.
	let p = inputPath;
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
	if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
	return path.resolve(p);
}

function normalizeSkillName(name: string): string {
	return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

type SkillIndexEntry = {
	name: string;
	skillFilePath: string;
	skillDir: string;
};

function buildSkillIndex(pi: ExtensionAPI, cwd: string): SkillIndexEntry[] {
	return pi
		.getCommands()
		.filter((c) => c.source === "skill")
		.map((c) => {
			const p = c.sourceInfo?.path ? normalizeReadPath(c.sourceInfo.path, cwd) : "";
			return {
				name: normalizeSkillName(c.name),
				skillFilePath: p,
				skillDir: p ? path.dirname(p) : "",
			};
		})
		.filter((x) => x.name && x.skillDir);
}

const SKILL_LOADED_ENTRY = "context:skill_loaded";

type SkillLoadedEntryData = { name: string; path: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getLoadedSkillsFromEntries(entries: Iterable<unknown>): Set<string> {
	const out = new Set<string>();
	for (const e of entries) {
		if (!isRecord(e)) continue;
		const entry = e;
		if (entry.type !== "custom") continue;
		if (entry.customType !== SKILL_LOADED_ENTRY) continue;
		if (isRecord(entry.data) && typeof entry.data.name === "string" && entry.data.name) out.add(entry.data.name);
	}
	return out;
}

export function getLoadedSkillsFromSession(ctx: ExtensionContext): Set<string> {
	return getLoadedSkillsFromEntries(ctx.sessionManager.getBranch());
}

function sumSessionUsage(ctx: ExtensionCommandContext): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	totalCost: number;
} {
	return sumAccountedUsage(ctx.sessionManager.getEntries());
}

function shortenPath(p: string, cwd: string): string {
	const rp = path.resolve(p);
	const rc = path.resolve(cwd);
	if (rp === rc) return ".";
	if (rp.startsWith(rc + path.sep)) return "./" + rp.slice(rc.length + 1);
	return rp;
}

function renderUsageBar(theme: Theme, parts: { system: number; convo: number }, total: number, width: number): string {
	const w = Math.max(10, width);
	if (total <= 0) return "";

	const toCols = (n: number) => Math.round((n / total) * w);
	let sys = toCols(parts.system);
	let con = toCols(parts.convo);
	let rem = w - sys - con;
	if (rem < 0) rem = 0;
	// adjust rounding drift
	while (sys + con + rem < w) rem++;
	while (sys + con + rem > w && rem > 0) rem--;

	const block = "█";
	const sysStr = theme.fg("accent", block.repeat(sys));
	const conStr = theme.fg("success", block.repeat(con));
	const remStr = theme.fg("dim", block.repeat(rem));
	return `${sysStr}${conStr}${remStr}`;
}

function joinComma(items: string[]): string {
	return items.join(", ");
}

function joinCommaStyled(items: string[], renderItem: (item: string) => string, sep: string): string {
	return items.map(renderItem).join(sep);
}

type ContextViewData = {
	usage: {
		// Pi's current context estimate already includes its actual prompt and tool loadout.
		contextTokens: number | null;
		contextWindow: number;
		percent: number | null;
		remainingTokens: number | null;
		systemPromptTokens: number;
		agentTokens: number;
	} | null;
	agentFiles: string[];
	extensions: string[];
	skills: string[];
	loadedSkills: string[];
	session: { totalTokens: number; totalCost: number };
};

class ContextView implements Component {
	private tui: TUI;
	private theme: Theme;
	private onDone: () => void;
	private data: ContextViewData;
	private container: Container;
	private body: Text;
	private cachedWidth?: number;

	constructor(tui: TUI, theme: Theme, data: ContextViewData, onDone: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.data = data;
		this.onDone = onDone;

		this.container = new Container();
		this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.container.addChild(
			new Text(theme.fg("accent", theme.bold("Context")) + theme.fg("dim", "  (Esc/q/Enter to close)"), 1, 0),
		);
		this.container.addChild(new Text("", 1, 0));

		this.body = new Text("", 1, 0);
		this.container.addChild(this.body);

		this.container.addChild(new Text("", 1, 0));
		this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	private rebuild(width: number): void {
		const muted = (s: string) => this.theme.fg("muted", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const text = (s: string) => this.theme.fg("text", s);

		const lines: string[] = [];

		// Window + bar
		if (!this.data.usage) {
			lines.push(muted("Window: ") + dim("(unknown)"));
		} else {
			const u = this.data.usage;
			if (u.contextTokens === null) {
				lines.push(muted("Window: ") + dim(`(unknown / ${u.contextWindow.toLocaleString()})`));
			} else {
				const used = u.contextTokens;
				lines.push(
					muted("Window: ") +
						text(`~${used.toLocaleString()} / ${u.contextWindow.toLocaleString()}`) +
						(u.percent === null || u.remainingTokens === null
							? ""
							: muted(`  (${u.percent.toFixed(1)}% used, ~${u.remainingTokens.toLocaleString()} left)`)),
				);

				const barWidth = Math.max(10, Math.min(36, width - 10));
				const systemInContext = Math.min(u.systemPromptTokens, used);
				const convoInContext = Math.max(0, used - systemInContext);
				const bar =
					renderUsageBar(
						this.theme,
						{ system: systemInContext, convo: convoInContext },
						u.contextWindow,
						barWidth,
					) +
					" " +
					dim("sys") +
					this.theme.fg("accent", "█") +
					" " +
					dim("context + loadout") +
					this.theme.fg("success", "█") +
					" " +
					dim("free") +
					this.theme.fg("dim", "█");
				lines.push(bar);
			}
		}

		lines.push("");

		// System prompt + tools totals (approx)
		if (this.data.usage) {
			const u = this.data.usage;
			lines.push(
				muted("System: ") +
					text(`~${u.systemPromptTokens.toLocaleString()} tok`) +
					muted(` (AGENTS ~${u.agentTokens.toLocaleString()})`),
			);
			lines.push(muted("Tools/loadout: ") + dim("included in window total"));
		}

		lines.push(
			muted(`AGENTS (${this.data.agentFiles.length}): `) +
				text(this.data.agentFiles.length ? joinComma(this.data.agentFiles) : "(none)"),
		);
		lines.push("");
		lines.push(
			muted(`Extensions (${this.data.extensions.length}): `) +
				text(this.data.extensions.length ? joinComma(this.data.extensions) : "(none)"),
		);

		const loaded = new Set(this.data.loadedSkills);
		const skillsRendered = this.data.skills.length
			? joinCommaStyled(
					this.data.skills,
					(name) => (loaded.has(name) ? this.theme.fg("success", name) : this.theme.fg("muted", name)),
					this.theme.fg("muted", ", "),
				)
			: "(none)";
		lines.push(muted(`Skills (${this.data.skills.length}): `) + skillsRendered);
		lines.push("");
		lines.push(
			muted("Session: ") +
				text(`${this.data.session.totalTokens.toLocaleString()} tokens`) +
				muted(" · ") +
				text(formatUsd(this.data.session.totalCost)),
		);

		this.body.setText(lines.join("\n"));
		this.cachedWidth = width;
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			data.toLowerCase() === "q" ||
			data === "\r"
		) {
			this.onDone();
			return;
		}
	}

	invalidate(): void {
		this.container.invalidate();
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedWidth !== width) this.rebuild(width);
		return this.container.render(width);
	}
}

export default function contextExtension(pi: ExtensionAPI) {
	// Track which skills were actually pulled in via read tool calls.
	let lastSessionId: string | null = null;
	let cachedLoadedSkills = new Set<string>();
	let cachedSkillIndex: SkillIndexEntry[] = [];

	const ensureCaches = (ctx: ExtensionContext) => {
		const sid = ctx.sessionManager.getSessionId();
		if (sid !== lastSessionId) {
			lastSessionId = sid;
			cachedSkillIndex = buildSkillIndex(pi, ctx.cwd);
		}
		// Loaded-skill records belong to a branch, not the append-only session file.
		cachedLoadedSkills = getLoadedSkillsFromSession(ctx);
		if (cachedSkillIndex.length === 0) {
			cachedSkillIndex = buildSkillIndex(pi, ctx.cwd);
		}
	};

	pi.on("session_start", () => {
		lastSessionId = null;
		cachedLoadedSkills = new Set();
		cachedSkillIndex = [];
	});

	const matchSkillForPath = (absPath: string): string | null => {
		let best: SkillIndexEntry | null = null;
		for (const s of cachedSkillIndex) {
			if (!s.skillDir) continue;
			if (absPath === s.skillFilePath || absPath.startsWith(s.skillDir + path.sep)) {
				if (!best || s.skillDir.length > best.skillDir.length) best = s;
			}
		}
		return best?.name ?? null;
	};

	pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
		// Only count successful reads.
		if (!isReadToolResult(event) || event.isError) return;

		const p = typeof event.input.path === "string" ? event.input.path : "";
		if (!p) return;

		ensureCaches(ctx);
		const abs = normalizeReadPath(p, ctx.cwd);
		const skillName = matchSkillForPath(abs);
		if (!skillName) return;

		if (!cachedLoadedSkills.has(skillName)) {
			cachedLoadedSkills.add(skillName);
			pi.appendEntry<SkillLoadedEntryData>(SKILL_LOADED_ENTRY, { name: skillName, path: abs });
		}
	});

	pi.registerCommand("context", {
		description: "Show loaded context overview",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const commands = pi.getCommands();
			const systemPromptOptions: BuildSystemPromptOptions = ctx.getSystemPromptOptions();
			const extensionCmds = commands.filter((c) => c.source === "extension");
			const skillCmds = commands.filter((c) => c.source === "skill");

			const extensionsByPath = new Map<string, string[]>();
			for (const c of extensionCmds) {
				const p = c.sourceInfo?.path ?? "<unknown>";
				const arr = extensionsByPath.get(p) ?? [];
				arr.push(c.name);
				extensionsByPath.set(p, arr);
			}
			const extensionFiles = [...extensionsByPath.keys()]
				.map((p) => (p === "<unknown>" ? p : path.basename(p)))
				.sort((a, b) => a.localeCompare(b));

			const agentFiles = (systemPromptOptions?.contextFiles ?? []).map((file) => ({
				path: file.path,
				tokens: estimateTokens(file.content),
			}));
			const agentFilePaths = agentFiles.map((f) => shortenPath(f.path, ctx.cwd));
			const agentTokens = agentFiles.reduce((a, f) => a + f.tokens, 0);

			const systemPrompt = ctx.getSystemPrompt();
			const systemPromptTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;

			const contextUsage = ctx.getContextUsage();
			const contextTokens = contextUsage?.tokens ?? null;
			const ctxWindow = contextUsage?.contextWindow ?? 0;
			const percent = contextTokens !== null && ctxWindow > 0 ? (contextTokens / ctxWindow) * 100 : null;
			const remainingTokens =
				contextTokens !== null && ctxWindow > 0 ? Math.max(0, ctxWindow - contextTokens) : null;
			const promptSkills = systemPromptOptions.skills?.map((skill) => skill.name);
			const skills =
				promptSkills?.slice().sort((a, b) => a.localeCompare(b)) ??
				skillCmds.map((c) => normalizeSkillName(c.name)).sort((a, b) => a.localeCompare(b));

			const sessionUsage = sumSessionUsage(ctx);

			const makePlainText = () => {
				const lines: string[] = [];
				lines.push("Context");
				if (contextUsage) {
					if (contextTokens === null) lines.push(`Window: (unknown / ${ctxWindow.toLocaleString()})`);
					else
						lines.push(
							`Window: ~${contextTokens.toLocaleString()} / ${ctxWindow.toLocaleString()}` +
								(percent === null || remainingTokens === null
									? ""
									: ` (${percent.toFixed(1)}% used, ~${remainingTokens.toLocaleString()} left)`),
						);
				} else {
					lines.push("Window: (unknown)");
				}
				lines.push(`System: ~${systemPromptTokens.toLocaleString()} tok (AGENTS ~${agentTokens.toLocaleString()})`);
				lines.push("Tools/loadout: included in window total");
				lines.push(`AGENTS: ${agentFilePaths.length ? joinComma(agentFilePaths) : "(none)"}`);
				lines.push(
					`Extensions (${extensionFiles.length}): ${extensionFiles.length ? joinComma(extensionFiles) : "(none)"}`,
				);
				lines.push(`Skills (${skills.length}): ${skills.length ? joinComma(skills) : "(none)"}`);
				lines.push(
					`Session: ${sessionUsage.totalTokens.toLocaleString()} tokens · ${formatUsd(sessionUsage.totalCost)}`,
				);
				return lines.join("\n");
			};

			if (ctx.mode !== "tui") {
				pi.sendMessage({ customType: "context", content: makePlainText(), display: true }, { triggerTurn: false });
				return;
			}

			const loadedSkills = Array.from(getLoadedSkillsFromSession(ctx)).sort((a, b) => a.localeCompare(b));

			const viewData: ContextViewData = {
				usage: contextUsage
					? {
							contextTokens,
							contextWindow: ctxWindow,
							percent,
							remainingTokens,
							systemPromptTokens,
							agentTokens,
						}
					: null,
				agentFiles: agentFilePaths,
				extensions: extensionFiles,
				skills,
				loadedSkills,
				session: { totalTokens: sessionUsage.totalTokens, totalCost: sessionUsage.totalCost },
			};

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				return new ContextView(tui, theme, viewData, done);
			});
		},
	});
}
