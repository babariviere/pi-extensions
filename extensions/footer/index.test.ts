import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import footer, { renderModel, renderUsageLine } from "./index.ts";

const plainTheme = {
	fg: (_color: unknown, text: string) => text,
	style: (value: string, style: { fg?: unknown }) => {
		const color = style.fg as { r: number; g: number; b: number };
		return `[${color.r},${color.g},${color.b}]${value}[/]`;
	},
} as Theme;

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("renders Codex in blue with its weekly reset", () => {
	const resetsAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
	const rendered = renderUsageLine(
		{
			provider: "openai",
			windows: [{ label: "Week", usedPercent: 12, resetsAt }],
		},
		plainTheme,
	);

	assert.match(rendered, /^\[59,130,246\]Codex\[\/\] /);
	assert.match(stripAnsi(rendered), /Week .* 12% ⟳ Week 7d0h$/);
});

test("hides empty Codex usage", () => {
	assert.equal(renderUsageLine({ provider: "openai", windows: [] }, plainTheme), "");
});

test("subscription provider colors pass concrete brand colors through the active theme", () => {
	const colors: Array<{ r: number; g: number; b: number }> = [];
	const theme = {
		fg: (_color: unknown, value: string) => value,
		style: (value: string, style: { fg?: unknown }) => {
			colors.push(style.fg as { r: number; g: number; b: number });
			return value;
		},
	} as Theme;
	const windows = [{ label: "Week", usedPercent: 12 }];

	renderUsageLine({ provider: "openai", windows }, theme);
	renderUsageLine({ provider: "anthropic", windows }, theme);
	assert.deepEqual(colors, [
		{ kind: "rgb", r: 59, g: 130, b: 246 },
		{ kind: "rgb", r: 217, g: 119, b: 87 },
	]);
});

test("footer distinguishes selection and latest physical response thinking levels", () => {
	const routed = renderModel(
		{ provider: "router", id: "auto", api: "pi-virtual" },
		{ provider: "openai-codex", id: "gpt-5.6-luna", thinkingLevel: "medium" },
		"high",
		false,
		plainTheme,
	);
	assert.equal(routed, "auto • high → gpt-5.6-luna • medium");

	const sameModelDifferentThinking = renderModel(
		{ provider: "anthropic", id: "claude-sonnet-4-5", reasoning: true },
		{ provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: "low" },
		"high",
		false,
		plainTheme,
	);
	assert.equal(sameModelDifferentThinking, "claude-sonnet-4-5 • high");
	assert.equal(
		renderModel(
			{ provider: "anthropic", id: "claude-sonnet", reasoning: true },
			{ provider: "openai-codex", id: "gpt-5", thinkingLevel: "low" },
			"high",
			false,
			plainTheme,
		),
		"claude-sonnet • high",
		"ordinary model switches should not show a stale routing arrow",
	);
});

function makeFooterExtension() {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	footer({
		events: { on: () => {}, emit: () => {} },
		getThinkingLevel: () => "off",
		on: (event: string, handler: (event: never, ctx: never) => unknown) => {
			handlers.set(event, handler);
			return () => {};
		},
	} as unknown as ExtensionAPI);
	return handlers;
}

test("footer does not install a TUI component in RPC mode", async () => {
	const handlers = makeFooterExtension();
	let installed = false;
	await handlers.get("session_start")?.(
		{} as never,
		{
			mode: "rpc",
			hasUI: true,
			ui: { setFooter: () => (installed = true) },
		} as never,
	);
	assert.equal(installed, false);
});

test("footer rendering reflects the active theme again after invalidation", async () => {
	const handlers = makeFooterExtension();
	let factory:
		| ((tui: never, theme: Theme, footerData: never) => { render(width: number): string[]; invalidate(): void })
		| undefined;
	await handlers.get("session_start")?.(
		{} as never,
		{
			mode: "tui",
			cwd: "/workspace",
			model: { provider: "openai", id: "gpt-5", contextWindow: 128_000 },
			getContextUsage: () => undefined,
			sessionManager: { getBranch: () => [] },
			ui: { setFooter: (value: typeof factory) => (factory = value) },
		} as never,
	);
	assert.ok(factory);
	const tui = { requestRender: () => {} } as never;
	const themeState = { accent: "theme-a" };
	const mutableTheme = {
		fg: (color: string, value: string) => (color === "accent" ? `[${themeState.accent}:${value}]` : value),
		style: (value: string) => value,
	} as unknown as Theme;
	const data = { getAvailableProviderCount: () => 1, getExtensionStatuses: () => new Map() } as never;
	const component = factory!(tui, mutableTheme, data);
	assert.ok(component.render(120).join("\n").includes("[theme-a:"));
	themeState.accent = "theme-b";
	component.invalidate();
	assert.ok(component.render(120).join("\n").includes("[theme-b:"));
});
