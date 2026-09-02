import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { PI_CORE_TOOL_NAMES } from "../core/pi-tools.ts";
import { PiToolsProvider } from "./pi-tools-provider.ts";

const context = {} as any;
const listRequest = {} as any;

const provider = () => new PiToolsProvider(process.cwd(), undefined, undefined);

test("the provider lists every pi core tool", async () => {
	const names = (await provider().list(listRequest, context)).map((descriptor) => descriptor.name);
	assert.deepEqual(names.sort(), [...PI_CORE_TOOL_NAMES].sort());
});

test("describe resolves a tool with its schema", async () => {
	const descriptor = await provider().describe("read", context);
	assert.equal(descriptor?.name, "read");
	assert.ok(descriptor?.inputSchema);
});

test("describe returns undefined for a tool that does not exist", async () => {
	assert.equal(await provider().describe("nope", context), undefined);
});

test("invoke reports an unknown tool as unknown", async () => {
	await assert.rejects(() => provider().invoke("nope", {}, context), /Unknown Pi tool: nope/);
});

// A subagent is bounded by its sandbox mode, not by a tool list, so the guard
// below (and the OS sandbox on `bash`) is the whole restriction surface.
const guardedProvider = (readGuard: (absolutePath: string) => void) =>
	new PiToolsProvider(process.cwd(), undefined, undefined, { readGuard });

test("read tools reject paths the read guard denies", async () => {
	const denied: string[] = [];
	const provider = guardedProvider((absolutePath) => {
		denied.push(absolutePath);
		if (absolutePath.startsWith("/deny")) {
			throw new Error(`sandbox: read of ${absolutePath} denied by mode 'read-only'`);
		}
	});
	await assert.rejects(
		() => provider.invoke("read", { path: "/deny/secret" }, context),
		/read of \/deny\/secret denied/,
	);
	await assert.rejects(() => provider.invoke("grep", { pattern: "x", path: "/deny/f" }, context), /denied/);
	await assert.rejects(() => provider.invoke("find", { pattern: "*.ts", path: "/deny" }, context), /denied/);
	await assert.rejects(() => provider.invoke("ls", { path: "/deny" }, context), /denied/);
	assert.deepEqual(denied, ["/deny/secret", "/deny/f", "/deny", "/deny"]);
});

test("the read guard sees resolved absolute paths", async () => {
	const seen: string[] = [];
	const provider = guardedProvider((absolutePath) => seen.push(absolutePath));
	// The guard passes; pi's read then fails on the missing file, which proves
	// the guard did not block and did not swallow the call.
	await assert.rejects(
		() => provider.invoke("read", { path: "relative/file.txt" }, context),
		(error: Error) => !/denied/.test(error.message),
	);
	assert.deepEqual(seen, [resolve(process.cwd(), "relative/file.txt")]);
});

test("a read the guard allows still executes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spindle-read-"));
	const file = join(dir, "a.txt");
	writeFileSync(file, "content\n");
	const provider = guardedProvider(() => {});
	const result = await provider.invoke("read", { path: file }, context);
	assert.equal(result, "content\n");
});
