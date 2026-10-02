import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_API, MODEL_SPECS } from "./config.ts";
import clef from "./index.ts";

test("provider registers Flash without loading weights, full is opt-in, and invalid config fails closed", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "clef-extension-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = cwd;
	const providers: ProviderConfig[] = [];
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	const notifications: string[] = [];
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		registerProvider: (name: string, config: ProviderConfig) => {
			assert.equal(name, "clef");
			providers.push(config);
		},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
			events.set(event, handler),
		registerCommand: (name: string, definition: { handler: typeof command }) => {
			assert.equal(name, "clef");
			command = definition.handler;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		isProjectTrusted: () => false,
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionCommandContext;
	try {
		clef(pi);
		assert.equal(providers[0].models?.[0].id, MODEL_SPECS.flash.id);
		assert.equal(providers[0].models?.[0].type, "classifier");
		await events.get("session_start")!({}, ctx);
		await command!("status", ctx);
		assert.match(notifications.at(-1)!, /clef-flash-4bit: unloaded/);
		writeFileSync(join(cwd, "clef.json"), JSON.stringify({ model: "full" }));
		await events.get("session_start")!({}, ctx);
		assert.equal(providers.at(-1)?.models?.[0].id, MODEL_SPECS.full.id);
		await command!("unload", ctx);
		assert.match(notifications.at(-1)!, /next classification loads/);
		writeFileSync(join(cwd, "clef.json"), JSON.stringify({ python: "python -u" }));
		await events.get("session_start")!({}, ctx);
		assert.match(notifications.at(-1)!, /python must/);
		const latest = providers.at(-1)!;
		const definition = latest.models![0];
		const result = await latest.classifiers![CLASSIFIER_API]!.classify(
			{
				...definition,
				api: CLASSIFIER_API,
				type: "classifier",
				provider: "clef",
				baseUrl: latest.baseUrl!,
				contextWindow: 8192,
			},
			{ state: {}, questions: { q: { type: "choice", instructions: "", criteria: { a: "A" } } } },
		);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, /python must/);
	} finally {
		await events.get("session_shutdown")?.({}, ctx);
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("trusted project settings select full; untrusted project settings are ignored", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "clef-config-"));
	const agentDir = join(cwd, "agent");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "clef.json"), JSON.stringify({ model: "full" }));
	let registered: ProviderConfig | undefined;
	let start: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
	let shutdown: (() => Promise<void>) | undefined;
	const pi = {
		registerProvider: (_name: string, config: ProviderConfig) => {
			registered = config;
		},
		registerCommand: () => {},
		on: (event: string, handler: typeof start) => {
			if (event === "session_start") start = handler;
			if (event === "session_shutdown") shutdown = handler as typeof shutdown;
		},
	} as unknown as ExtensionAPI;
	try {
		clef(pi);
		await start!({}, { cwd, isProjectTrusted: () => false } as ExtensionContext);
		assert.equal(registered!.models![0].id, MODEL_SPECS.flash.id);
		await start!({}, { cwd, isProjectTrusted: () => true } as ExtensionContext);
		assert.equal(registered!.models![0].id, MODEL_SPECS.full.id);
	} finally {
		await shutdown?.();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Python worker protocol and adapter tests run without MLX or checkpoint downloads", (t) => {
	const result = spawnSync("python3", ["-B", fileURLToPath(new URL("./worker_test.py", import.meta.url))], {
		encoding: "utf8",
		timeout: 30_000,
	});
	if (result.error && "code" in result.error && result.error.code === "ENOENT") {
		t.skip("python3 is not installed; run worker_test.py during Python setup");
		return;
	}
	assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ""));
});
