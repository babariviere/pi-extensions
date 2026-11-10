import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import browserExtension from "../../browser/index.ts";
import { BrowserManager } from "../../browser/manager.ts";
import webExtension from "../../web/index.ts";
import { Cdp } from "./cdp.ts";
import { browserProfileDir } from "./launch.ts";
import { closeIdleBrowser, isAgentBrowser } from "./shutdown.ts";

const port = 9333;
const command = `/Applications/Helium.app/Contents/MacOS/Helium --remote-debugging-port=${port} --user-data-dir=${browserProfileDir("helium")}`;

function setup(t: TestContext, options: { command?: string; targets?: { type: string }[]; fail?: string } = {}) {
	const calls: string[] = [];
	const closed: boolean[] = [];
	t.mock.method(globalThis, "fetch", async () => Response.json({ webSocketDebuggerUrl: "ws://unused" }));
	t.mock.method(Cdp.prototype, "connect", async () => {});
	t.mock.method(Cdp.prototype, "call", async (method: string) => {
		calls.push(method);
		if (method === options.fail) throw new Error("Browser is unresponsive");
		if (method === "SystemInfo.getProcessInfo") return { processInfo: [{ type: "browser", id: 123 }] };
		if (method === "Target.getTargets") return { targetInfos: options.targets ?? [] };
		return {};
	});
	t.mock.method(Cdp.prototype, "close", (terminate: boolean) => closed.push(terminate));
	t.mock.method(
		childProcess,
		"execFile",
		(_file: string, args: string[], opts: { timeout: number }, callback: (error: null, stdout: string) => void) => {
			assert.deepEqual(args, ["-ww", "-p", "123", "-o", "command="]);
			assert.equal(opts.timeout, 1_000);
			callback(null, options.command ?? command);
			return {} as ChildProcess;
		},
	);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	return { calls, closed };
}

test("recognizes only the dedicated profile and exact debugging port", () => {
	assert.equal(isAgentBrowser(command, port), true);
	assert.equal(isAgentBrowser(command, 933), false);
	assert.equal(isAgentBrowser(command.replace("helium-profile", "everyday-profile"), port), false);
	assert.equal(isAgentBrowser(`${command}-other`, port), false);
	assert.equal(isAgentBrowser(command.replace("--remote-debugging", "prefix--remote-debugging"), port), false);
});

test("session cleanup quits an idle dedicated browser and terminates its cleanup socket", async (t) => {
	const { calls, closed } = setup(t);
	await closeIdleBrowser(port);
	assert.deepEqual(calls, ["SystemInfo.getProcessInfo", "Target.getTargets", "Browser.close"]);
	assert.deepEqual(closed, [true]);
});

for (const type of ["page", "webview", "background_page"]) {
	test(`does not quit while another session has a ${type} target`, async (t) => {
		const { calls, closed } = setup(t, { targets: [{ type }] });
		await closeIdleBrowser(port);
		assert.equal(calls.includes("Browser.close"), false);
		assert.deepEqual(closed, [true]);
	});
}

test("persistent service workers do not keep an idle browser running", async (t) => {
	const { calls } = setup(t, { targets: [{ type: "service_worker" }] });
	await closeIdleBrowser(port);
	assert.equal(calls.includes("Browser.close"), true);
});

test("never quits an unrelated browser reused on the debugging port", async (t) => {
	const { calls } = setup(t, { command: "Chrome --remote-debugging-port=9333 --user-data-dir=/my/profile" });
	await closeIdleBrowser(port);
	assert.deepEqual(calls, ["SystemInfo.getProcessInfo"]);
});

for (const fail of ["SystemInfo.getProcessInfo", "Target.getTargets", "Browser.close"]) {
	test(`cleanup tolerates ${fail} failures`, async (t) => {
		const { closed } = setup(t, { fail });
		await closeIdleBrowser(port);
		assert.deepEqual(closed, [true]);
	});
}

test("an absent browser is not launched at session end", async (t) => {
	const { calls, closed } = setup(t);
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("Connection refused");
	});
	await closeIdleBrowser(port);
	assert.deepEqual(calls, []);
	assert.deepEqual(closed, []);
});

for (const extension of [browserExtension, webExtension]) {
	test(`${extension === browserExtension ? "browser" : "web"} cleans up the browser on session shutdown`, async (t) => {
		const { calls } = setup(t);
		const handlers = new Map<string, () => Promise<void>>();
		t.mock.method(BrowserManager.prototype, "close", async () => {
			calls.push("manager.close");
		});
		extension({
			registerTool() {},
			registerCommand() {},
			on(event: string, handler: () => Promise<void>) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI);
		assert.ok(handlers.has("session_shutdown"));
		await handlers.get("session_shutdown")!();
		assert.equal(calls.at(-1), "Browser.close");
		if (extension === browserExtension) assert.equal(calls[0], "manager.close");
	});
}
