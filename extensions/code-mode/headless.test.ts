import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CapturedToolCatalog } from "./capture/catalog.ts";
import { CodeModeState } from "./code-mode-state.ts";
import headlessCodeMode from "./headless.ts";

test("headless extension rejects interactive use without registering tools", () => {
	const original = process.env.PI_BACKGROUND_AGENT_ATTEMPT;
	delete process.env.PI_BACKGROUND_AGENT_ATTEMPT;
	try {
		let registered = false;
		assert.throws(
			() =>
				headlessCodeMode({
					registerTool: () => {
						registered = true;
					},
				} as unknown as ExtensionAPI),
			/background attempt/,
		);
		assert.equal(registered, false);
	} finally {
		if (original === undefined) delete process.env.PI_BACKGROUND_AGENT_ATTEMPT;
		else process.env.PI_BACKGROUND_AGENT_ATTEMPT = original;
	}
});

test("headless extension registers only Code Mode and loads only pi and MCP providers", async () => {
	const root = mkdtempSync(join(tmpdir(), "code-mode-headless-"));
	const previous = {
		attempt: process.env.PI_BACKGROUND_AGENT_ATTEMPT,
		role: process.env.PI_BACKGROUND_AGENT_ROLE,
		profile: process.env.PI_CODING_AGENT_DIR,
	};
	process.env.PI_BACKGROUND_AGENT_ATTEMPT = "1";
	process.env.PI_BACKGROUND_AGENT_ROLE = "spec-planner";
	process.env.PI_CODING_AGENT_DIR = root;
	writeFileSync(
		join(root, "code-mode.json"),
		JSON.stringify({
			fullCodeMode: true,
			sandbox: { mode: "read-only", denyRead: [root] },
			mcp: { readOnly: true },
		}),
	);
	const callbacks = new Map<string, Array<(...args: any[]) => any>>();
	const tools: string[] = [];
	const active: string[][] = [];
	const commands: string[] = [];
	const pi = {
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerCommand: (name: string) => commands.push(name),
		setActiveTools: (names: string[]) => active.push(names),
		on: (name: string, fn: (...args: any[]) => any) => callbacks.set(name, [...(callbacks.get(name) ?? []), fn]),
		events: { emit: () => {}, on: () => () => {} },
	} as unknown as ExtensionAPI;
	const context = {
		cwd: root,
		hasUI: false,
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "attempt", getSessionFile: () => join(root, "session.jsonl") },
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;
	try {
		headlessCodeMode(pi);
		assert.deepEqual(tools, ["code_mode"]);
		assert.deepEqual(commands, []);
		await assert.rejects(callbacks.get("session_start")![0]!({}, { ...context, hasUI: true }), /print mode/);
		await assert.rejects(
			callbacks.get("session_start")![0]!({}, { ...context, isProjectTrusted: () => true }),
			/repository-local settings/,
		);
		await callbacks.get("session_start")![0]!({}, context);
		assert.deepEqual(active, [["code_mode"]]);
		const state = new CodeModeState(pi, new CapturedToolCatalog(), { headless: true });
		await state.initialize(context);
		assert.deepEqual(
			state.registry.providers().map((provider) => provider.name),
			["mcp", "pi"],
		);
		await state.shutdown();
		const guidance = callbacks.get("before_agent_start")![0]!({ systemPrompt: "Role instructions" }, context);
		assert.match(guidance.systemPrompt, /Role instructions.*Use code_mode/s);
		assert.match(guidance.systemPrompt, /do not modify files/);
		await callbacks.get("session_shutdown")![0]!();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			const name =
				key === "attempt"
					? "PI_BACKGROUND_AGENT_ATTEMPT"
					: key === "role"
						? "PI_BACKGROUND_AGENT_ROLE"
						: "PI_CODING_AGENT_DIR";
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
});
