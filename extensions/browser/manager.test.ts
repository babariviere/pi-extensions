import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { Cdp } from "../shared/browser/cdp.ts";
import { BrowserManager } from "./manager.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

interface Call {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
}

/** In-memory CDP peer: native window resizing is independent of metric overrides. */
class TestCdp extends Cdp {
	readonly calls: Call[] = [];
	readonly overrides = new Map<string, { width: number; height: number }>();
	readonly failedSessions = new Set<string>();
	windowSize = { width: 1470, height: 1300 };
	private nextTarget = 1;

	constructor() {
		super("ws://unused");
	}

	lastCall(method: string): Call {
		const call = this.calls.filter((call) => call.method === method).at(-1);
		assert.ok(call, `Expected a ${method} call`);
		return call;
	}

	override get isOpen(): boolean {
		return true;
	}

	override async call(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<Record<string, unknown>> {
		this.calls.push({ method, params, sessionId });
		if (sessionId && this.failedSessions.has(sessionId)) throw new Error("Session closed");
		switch (method) {
			case "Target.createTarget":
				return { targetId: `target-${this.nextTarget++}` };
			case "Target.attachToTarget":
				return { sessionId: params.targetId };
			case "Browser.getWindowForTarget":
				return { windowId: 1, bounds: { windowState: "normal" } };
			case "SystemInfo.getProcessInfo":
				return { processInfo: [{ type: "browser", id: 123 }] };
			case "Emulation.setDeviceMetricsOverride":
				this.overrides.set(sessionId!, { width: Number(params.width), height: Number(params.height) });
				return {};
			case "Emulation.clearDeviceMetricsOverride":
				this.overrides.delete(sessionId!);
				return {};
			case "Page.getLayoutMetrics": {
				const { width, height } = this.overrides.get(sessionId!) ?? this.windowSize;
				return {
					cssLayoutViewport: { clientWidth: width, clientHeight: height },
					cssContentSize: { width, height: 20_000 },
				};
			}
			case "Page.captureScreenshot":
				return { data: "AAAA" };
			default:
				return {};
		}
	}
}

function setup(t: TestContext) {
	// Never invoke a desktop helper, including when these tests run on macOS.
	t.mock.method(
		childProcess,
		"execFile",
		(
			_file: string,
			_args: string[],
			_options: unknown,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			callback(null, "", "");
			return {} as ChildProcess;
		},
	);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	const cdp = new TestCdp();
	const manager = new BrowserManager(DEFAULT_SETTINGS);
	// Substitute transport and settling only; exercise actions through the public API.
	Object.assign(manager, { cdp, settle: async () => {} });
	t.after(() => manager.close());
	const open = () => manager.run({ action: "open", url: "about:blank", snapshot: false });
	return { cdp, manager, open };
}

test("hidden tabs retain the configured fixed viewport", async (t) => {
	const { cdp, open } = setup(t);
	await open();
	await open();
	assert.equal(cdp.overrides.size, 2);
	for (const viewport of cdp.overrides.values()) assert.deepEqual(viewport, DEFAULT_SETTINGS.viewport);
	assert.equal(
		cdp.calls.some((call) => call.method === "Emulation.clearDeviceMetricsOverride"),
		false,
	);
});

test("show and hide switch every tab, including tabs opened while visible", async (t) => {
	const { cdp, manager, open } = setup(t);
	const first = await open();
	await open();
	await manager.run({ action: "show", pageId: first.pageId });
	assert.equal(cdp.overrides.size, 0);
	assert.deepEqual(
		cdp.calls.filter((call) => call.method === "Emulation.clearDeviceMetricsOverride").map((call) => call.sessionId),
		["target-1", "target-2"],
	);
	await open();
	assert.equal(cdp.overrides.size, 0);
	assert.equal(cdp.lastCall("Emulation.clearDeviceMetricsOverride").sessionId, "target-3");
	await manager.run({ action: "hide" });
	assert.equal(cdp.overrides.size, 3);
	await open();
	assert.equal(cdp.overrides.size, 4);
	for (const viewport of cdp.overrides.values()) assert.deepEqual(viewport, DEFAULT_SETTINGS.viewport);
	await manager.run({ action: "show", pageId: first.pageId });
	assert.equal(cdp.overrides.size, 0);
	// Only change window state; leave dimensions to the compositor.
	for (const call of cdp.calls.filter((call) => call.method === "Browser.setWindowBounds")) {
		assert.deepEqual(Object.keys(call.params.bounds as object), ["windowState"]);
	}
});

test("scrolling follows native window resizes and returns to the fixed viewport when hidden", async (t) => {
	const { cdp, manager, open } = setup(t);
	await open();
	await manager.run({ action: "show" });
	await manager.run({ action: "scroll", snapshot: false });
	let wheel = cdp.lastCall("Input.dispatchMouseEvent");
	assert.deepEqual(wheel.params, { type: "mouseWheel", x: 735, y: 650, deltaX: 0, deltaY: 1040 });
	cdp.windowSize = { width: 600, height: 500 };
	await manager.run({ action: "scroll", direction: "left", snapshot: false });
	wheel = cdp.lastCall("Input.dispatchMouseEvent");
	assert.deepEqual(wheel.params, { type: "mouseWheel", x: 300, y: 250, deltaX: -480, deltaY: 0 });
	await manager.run({ action: "hide" });
	await manager.run({ action: "scroll", amount: 50, snapshot: false });
	wheel = cdp.lastCall("Input.dispatchMouseEvent");
	assert.deepEqual(wheel.params, { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: 50 });
});

test("a closed tab cannot prevent showing or hiding healthy tabs", async (t) => {
	const { cdp, manager, open } = setup(t);
	const first = await open();
	await open();
	cdp.failedSessions.add("target-2");
	await manager.run({ action: "show", pageId: first.pageId });
	assert.equal(cdp.overrides.has("target-1"), false);
	assert.deepEqual(cdp.lastCall("Browser.setWindowBounds").params.bounds, { windowState: "normal" });
	await manager.run({ action: "hide" });
	assert.deepEqual(cdp.overrides.get("target-1"), DEFAULT_SETTINGS.viewport);
	assert.deepEqual(cdp.lastCall("Browser.setWindowBounds").params.bounds, { windowState: "minimized" });
});

test("full-page screenshots use the current width and preserve the height cap", async (t) => {
	const { cdp, manager, open } = setup(t);
	await open();
	for (const width of [1280, 1470, 600, 1280]) {
		if (width === 1470) await manager.run({ action: "show" });
		if (width === 600) cdp.windowSize = { width, height: 500 };
		if (width === 1280) await manager.run({ action: "hide" });
		const result = await manager.run({ action: "screenshot", fullPage: true });
		assert.equal(result.image?.data, "AAAA");
		const shot = cdp.lastCall("Page.captureScreenshot");
		assert.deepEqual(shot.params, {
			format: "png",
			captureBeyondViewport: true,
			clip: { x: 0, y: 0, width, height: DEFAULT_SETTINGS.maxScreenshotHeight, scale: 1 },
		});
	}
});
