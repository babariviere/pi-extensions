import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, VStack, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import preview from "./index.ts";

type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

function register() {
	let command: RegisteredCommand | undefined;
	preview({
		registerCommand: (_name: string, value: RegisteredCommand) => (command = value),
	} as unknown as ExtensionAPI);
	return command;
}

function keybindings() {
	const keys: Record<string, string> = {
		"tui.select.up": "up",
		"tui.select.down": "down",
		"tui.select.pageUp": "page-up",
		"tui.select.pageDown": "page-down",
		"tui.select.confirm": "enter",
		"tui.select.cancel": "escape",
		"tui.altScreen.top": "home",
		"tui.altScreen.bottom": "end",
	};
	return { matches: (data: string, action: string) => keys[action] === data } as unknown as KeybindingsManager;
}

const theme = {
	fg: (_color: unknown, text: string) => text,
} as Theme;

test("non-TUI command uses a graceful fallback without opening a custom component", async () => {
	const command = register();
	const notices: string[] = [];
	let customCalls = 0;
	await command?.handler("", {
		mode: "rpc",
		getSystemPrompt: () => "private prompt",
		ui: {
			notify: (message: string) => notices.push(message),
			custom: () => {
				customCalls += 1;
				return Promise.resolve(null);
			},
		},
	} as never);
	assert.equal(customCalls, 0);
	assert.deepEqual(notices, ["The system prompt viewer is available only in interactive TUI mode."]);
});

test("regular TUI viewer scrolls by line and page and resizes with terminal rows", async () => {
	const command = register();
	let factory:
		| ((tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: null) => void) => Component)
		| undefined;
	await command?.handler("", {
		mode: "tui",
		getSystemPrompt: () => Array.from({ length: 40 }, (_, index) => `prompt row ${index + 1}`).join("\n"),
		ui: {
			notify: () => {},
			custom: (value: typeof factory) => {
				factory = value;
				return Promise.resolve(null);
			},
		},
	} as never);

	assert.ok(factory);
	let rows = 8;
	let done = false;
	const tui = {
		mode: "regular",
		terminal: { rows },
		requestRender: () => {},
	} as unknown as TUI;
	const component = factory!(tui, theme, keybindings(), () => (done = true));
	assert.equal(component.render(100).length, 8);
	assert.equal(component.render(15).length, 8, "narrow terminal widths remain within the row budget");
	assert.ok(component.render(100).some((line) => line.includes("prompt row 1")));
	assert.equal(
		component.render(100).some((line) => line.includes("prompt row 7")),
		false,
	);

	component.handleInput?.("down");
	assert.ok(component.render(100).some((line) => line.includes("prompt row 2")));
	component.handleInput?.("page-down");
	assert.ok(component.render(100).some((line) => line.includes("prompt row 8")));
	component.handleInput?.("home");
	assert.ok(component.render(100).some((line) => line.includes("prompt row 1")));
	component.handleInput?.("end");
	assert.ok(component.render(100).some((line) => line.includes("prompt row 40")));

	rows = 5;
	(tui.terminal as { rows: number }).rows = rows;
	assert.equal(component.render(100).length, rows);
	rows = 2;
	(tui.terminal as { rows: number }).rows = rows;
	assert.equal(component.render(100).length, rows);
	rows = 1;
	(tui.terminal as { rows: number }).rows = rows;
	assert.equal(component.render(100).length, rows);
	component.handleInput?.("enter");
	assert.equal(done, true);
});

test("fullscreen viewer exposes a native scroll view inside a flexible layout", async () => {
	const command = register();
	let factory:
		| ((tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: null) => void) => Component)
		| undefined;
	await command?.handler("", {
		mode: "tui",
		getSystemPrompt: () => "first\nsecond\nthird",
		ui: { notify: () => {}, custom: (value: typeof factory) => ((factory = value), Promise.resolve(null)) },
	} as never);
	const themeState = { muted: "muted-a" };
	const themedTheme = {
		fg: (color: string, value: string) => `[${color === "muted" ? themeState.muted : color}:${value}]`,
	} as unknown as Theme;
	const component = factory!(
		{ mode: "fullscreen", terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI,
		themedTheme,
		keybindings(),
		() => {},
	);
	assert.ok(component instanceof VStack);
	const scrollView = (component as VStack).children.find((child): child is ScrollView => child instanceof ScrollView);
	assert.ok(scrollView);
	const body = scrollView.render(80).join("\n");
	assert.match(body, /first/);
	assert.match(body, /second/);
	assert.match(body, /third/);
	assert.match(body, /muted-a:1/);
	themeState.muted = "muted-b";
	component.invalidate();
	assert.match(scrollView.render(80).join("\n"), /muted-b:1/);
});
