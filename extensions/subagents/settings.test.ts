import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { readDefaultProvider, readEnabledModels } from "./settings.ts";

let dir: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sa-settings-"));
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	rmSync(dir, { recursive: true, force: true });
});

function writeSettings(base: string, defaultProvider: unknown): void {
	mkdirSync(join(base, ".pi"), { recursive: true });
	writeFileSync(join(base, ".pi", "settings.json"), JSON.stringify(defaultProvider === undefined ? {} : { defaultProvider }));
}

test("readDefaultProvider reads user settings via PI_CODING_AGENT_DIR", () => {
	const userAgentDir = join(dir, "user");
	mkdirSync(userAgentDir, { recursive: true });
	writeFileSync(join(userAgentDir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic" }));
	process.env.PI_CODING_AGENT_DIR = userAgentDir;

	const cwd = join(dir, "proj");
	mkdirSync(cwd, { recursive: true });
	assert.equal(readDefaultProvider(cwd), "anthropic");
});

test("project .pi/settings.json overrides user settings", () => {
	const userAgentDir = join(dir, "user");
	mkdirSync(userAgentDir, { recursive: true });
	writeFileSync(join(userAgentDir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic" }));
	process.env.PI_CODING_AGENT_DIR = userAgentDir;

	const cwd = join(dir, "proj");
	writeSettings(cwd, "openai");
	assert.equal(readDefaultProvider(cwd), "openai");
});

test("readDefaultProvider returns undefined when nothing sets it", () => {
	const userAgentDir = join(dir, "user-empty");
	mkdirSync(userAgentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = userAgentDir;

	const cwd = join(dir, "proj-empty");
	mkdirSync(cwd, { recursive: true });
	assert.equal(readDefaultProvider(cwd), undefined);
});

test("readEnabledModels reads user settings and trims/filters entries", () => {
	const userAgentDir = join(dir, "user");
	mkdirSync(userAgentDir, { recursive: true });
	writeFileSync(
		join(userAgentDir, "settings.json"),
		JSON.stringify({ enabledModels: ["anthropic/claude-sonnet-5", " anthropic/claude-opus-4-8 ", "", 42] }),
	);
	process.env.PI_CODING_AGENT_DIR = userAgentDir;

	const cwd = join(dir, "proj");
	mkdirSync(cwd, { recursive: true });
	assert.deepEqual(readEnabledModels(cwd), ["anthropic/claude-sonnet-5", "anthropic/claude-opus-4-8"]);
});

test("project enabledModels overrides user settings", () => {
	const userAgentDir = join(dir, "user");
	mkdirSync(userAgentDir, { recursive: true });
	writeFileSync(join(userAgentDir, "settings.json"), JSON.stringify({ enabledModels: ["anthropic/claude-opus-4-8"] }));
	process.env.PI_CODING_AGENT_DIR = userAgentDir;

	const cwd = join(dir, "proj");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["anthropic/claude-sonnet-5"] }));
	assert.deepEqual(readEnabledModels(cwd), ["anthropic/claude-sonnet-5"]);
});

test("readEnabledModels returns [] when nothing sets it", () => {
	const userAgentDir = join(dir, "user-empty");
	mkdirSync(userAgentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = userAgentDir;

	const cwd = join(dir, "proj-empty");
	mkdirSync(cwd, { recursive: true });
	assert.deepEqual(readEnabledModels(cwd), []);
});
