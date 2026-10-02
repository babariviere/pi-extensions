import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	ScrollView,
	Text,
	TuiAltScreen,
	getKeybindings,
	visibleWidth,
	type Component,
	type KeybindingsManager,
	type OverlayOptions,
	type TUI,
	type Terminal,
} from "@earendil-works/pi-tui";
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
	for (const width of [1, 2, 5, 15]) {
		assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
	}
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

test("fullscreen viewer bounds its viewport and scrolls when rendered as a custom component", async () => {
	const command = register();
	let factory:
		| ((tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: null) => void) => Component)
		| undefined;
	await command?.handler("", {
		mode: "tui",
		getSystemPrompt: () => Array.from({ length: 40 }, (_, index) => `prompt row ${index + 1}`).join("\n"),
		ui: { notify: () => {}, custom: (value: typeof factory) => ((factory = value), Promise.resolve(null)) },
	} as never);
	const themeState = { muted: "muted-a" };
	const themedTheme = {
		fg: (color: string, value: string) => `[${color === "muted" ? themeState.muted : color}:${value}]`,
	} as unknown as Theme;
	const tui = { mode: "fullscreen", terminal: { rows: 8 }, requestRender: () => {} } as unknown as TUI;
	const component = factory!(tui, themedTheme, keybindings(), () => {});
	const body = component.render(80).join("\n");
	assert.equal(component.render(80).length, 8);
	assert.match(body, /prompt row 1/);
	assert.doesNotMatch(body, /prompt row 7/);
	assert.match(body, /muted-a: 1/);
	component.handleInput?.("down");
	assert.match(component.render(80)[1], /prompt row 2/);
	component.handleInput?.("page-down");
	assert.match(component.render(80)[1], /prompt row 8/);
	component.handleInput?.("page-up");
	assert.match(component.render(80)[1], /prompt row 2/);
	component.handleInput?.("up");
	assert.match(component.render(80)[1], /prompt row 1/);
	component.handleInput?.("end");
	assert.match(component.render(80).join("\n"), /prompt row 40/);
	component.handleInput?.("home");
	themeState.muted = "muted-b";
	component.invalidate();
	assert.match(component.render(80).join("\n"), /muted-b: 1/);
	(tui.terminal as { rows: number }).rows = 5;
	assert.equal(component.render(80).length, 5);
});

for (const closeKey of ["\r", "\x1b"]) {
	test(`fullscreen renderer routes keyboard and wheel scrolling to the viewer (close ${JSON.stringify(closeKey)})`, async (t) => {
		let input = (_data: string) => {};
		const terminal: Terminal & { rows: number; columns: number } = {
			rows: 8,
			columns: 100,
			kittyProtocolActive: false,
			start: (onInput) => {
				input = onInput;
			},
			stop: () => {},
			drainInput: async () => {},
			write: () => {},
			moveBy: () => {},
			hideCursor: () => {},
			showCursor: () => {},
			clearLine: () => {},
			clearFromCursor: () => {},
			clearScreen: () => {},
			setTitle: () => {},
			setProgress: () => {},
		};
		const tui = new TuiAltScreen(terminal);
		t.after(() => tui.stop());
		const transcript = new ScrollView(new Text("transcript\n".repeat(40), 0, 0), { primary: true });
		tui.setLayoutRoot(transcript);
		tui.start();
		tui.renderNow();
		transcript.scrollTo(10);
		tui.renderNow();

		const command = register();
		assert.ok(command);
		const result = command.handler("", {
			mode: "tui",
			getSystemPrompt: () => Array.from({ length: 40 }, (_, index) => `prompt row ${index + 1}`).join("\n"),
			ui: {
				custom: (
					factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: null) => void) => Component,
					options: { overlay?: boolean; overlayOptions?: OverlayOptions },
				) =>
					new Promise<null>((resolve) => {
						assert.equal(options.overlay, true, "viewer must own fullscreen scrolling keys");
						const component = factory(tui, theme, getKeybindings(), (value) => {
							tui.hideOverlay();
							resolve(value);
						});
						tui.showOverlay(component, options.overlayOptions);
					}),
			},
		} as never);
		tui.renderNow();
		assert.match(tui.getScreenLines()[1], /prompt row 1/);
		const send = (data: string) => {
			input(data);
			tui.renderNow();
			assert.equal(transcript.scrollTop, 10, "viewer input must not scroll the transcript");
		};
		send("\x1b[B");
		assert.match(tui.getScreenLines()[1], /prompt row 2/);
		send("\x1b[6~");
		assert.match(tui.getScreenLines()[1], /prompt row 8/);
		send("\x1b[5~");
		assert.match(tui.getScreenLines()[1], /prompt row 2/);
		send("\x1b[H");
		assert.match(tui.getScreenLines()[1], /prompt row 1/);
		send("\x1b[<65;5;3M");
		assert.doesNotMatch(tui.getScreenLines()[1], /prompt row 1\b/);
		send("\x1b[F");
		assert.match(tui.getScreenLines().join("\n"), /prompt row 40/);
		send("\x1b[<65;5;3M");
		assert.match(tui.getScreenLines().join("\n"), /prompt row 40/);
		send("\x1b[<64;5;3M");
		assert.doesNotMatch(tui.getScreenLines().join("\n"), /prompt row 40/);
		send("\x1b[H");
		terminal.rows = 5;
		tui.renderNow();
		assert.match(tui.getScreenLines()[1], /prompt row 1/);
		assert.doesNotMatch(tui.getScreenLines().join("\n"), /prompt row 4/);
		send(closeKey);
		await result;
		assert.equal(tui.hasOverlay(), false);
	});
}
