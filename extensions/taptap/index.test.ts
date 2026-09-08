import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import taptap from "./index.ts";

function setup() {
	let start: ((event: { type: "session_start" }, ctx: ExtensionContext) => void) | undefined;
	let editor: CustomEditor | undefined;
	let controller: AbortController | undefined;
	let aborts = 0;
	let status: string | undefined;
	const ctx = {
		mode: "tui",
		isIdle: () => controller === undefined,
		get signal() {
			return controller?.signal;
		},
		abort: () => {
			aborts++;
			controller?.abort();
		},
		ui: {
			setStatus: (_key: string, value: string | undefined) => {
				status = value;
			},
			setEditorComponent: (factory: NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>) => {
				editor = factory(
					{ requestRender() {} } as unknown as TUI,
					{ borderColor: (text: string) => text } as EditorTheme,
					{
						matches: (data: string, action: string) => data === escape && action === "app.interrupt",
					} as KeybindingsManager,
				) as CustomEditor;
			},
		},
	} as unknown as ExtensionContext;
	taptap({
		on: (event: string, handler: typeof start) => {
			if (event === "session_start") start = handler;
		},
	} as unknown as ExtensionAPI);
	assert.ok(start);
	start({ type: "session_start" }, ctx);
	assert.ok(editor);
	return {
		editor,
		beginRun: () => {
			controller = new AbortController();
			return controller;
		},
		get aborts() {
			return aborts;
		},
		get status() {
			return status;
		},
	};
}

const escape = "\x1b";

describe("taptap editor cancellation", () => {
	it("aborts a pending tool when the editor handler does not cancel the run", async () => {
		const h = setup();
		const run = h.beginRun();
		let forwarded = 0;
		h.editor.onEscape = () => {
			forwarded++;
		};
		const tool = new Promise<void>((resolve) =>
			run.signal.addEventListener("abort", () => resolve(), { once: true }),
		);
		h.editor.handleInput(escape);
		assert.equal(h.status, "esc again to cancel");
		assert.equal(run.signal.aborted, false);
		assert.equal(forwarded, 0);
		h.editor.handleInput(escape);
		assert.equal(forwarded, 1);
		assert.equal(run.signal.aborted, true);
		assert.equal(h.aborts, 1);
		assert.equal(h.status, undefined);
		await tool;
	});

	it("does not abort twice when the native handler already cancelled", () => {
		const h = setup();
		const run = h.beginRun();
		h.editor.onEscape = () => run.abort();
		h.editor.handleInput(escape);
		h.editor.handleInput(escape);
		assert.equal(run.signal.aborted, true);
		assert.equal(h.aborts, 0);
	});

	it("uses the current signal across runs, even without an editor handler", () => {
		const h = setup();
		for (let i = 0; i < 2; i++) {
			const run = h.beginRun();
			h.editor.handleInput(escape);
			assert.equal(run.signal.aborted, false);
			h.editor.handleInput(escape);
			assert.equal(run.signal.aborted, true);
		}
		assert.equal(h.aborts, 2);
	});

	it("preserves idle Escape dispatch without calling abort", () => {
		const h = setup();
		let forwarded = 0;
		h.editor.onEscape = () => {
			forwarded++;
		};
		h.editor.handleInput(escape);
		h.editor.handleInput(escape);
		assert.equal(forwarded, 2);
		assert.equal(h.aborts, 0);
		assert.equal(h.status, undefined);
	});

	it("leaves autocomplete cancellation to the base editor", () => {
		const h = setup();
		const run = h.beginRun();
		h.editor.isShowingAutocomplete = () => true;
		h.editor.handleInput(escape);
		h.editor.handleInput(escape);
		assert.equal(run.signal.aborted, false);
		assert.equal(h.aborts, 0);
		assert.equal(h.status, undefined);
	});

	it("reads a replaced native handler on the second tap", () => {
		const h = setup();
		const run = h.beginRun();
		h.editor.onEscape = () => assert.fail("stale handler");
		h.editor.handleInput(escape);
		h.editor.onEscape = () => run.abort();
		h.editor.handleInput(escape);
		assert.equal(run.signal.aborted, true);
		assert.equal(h.aborts, 0);
	});
});
