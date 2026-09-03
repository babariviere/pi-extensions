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

/**
 * The 2026-09-03 data loss: a 51 KB notes file was restructured from a
 * truncated read, so nine lines were dropped and pi's truncation notice was
 * written into the file as content. Inside the sandbox a short read must fail,
 * not read like a whole one.
 */
test("a read past pi's limit fails instead of returning a silent head", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spindle-read-limit-"));
	const file = join(dir, "big.md");
	// 60 KB of short lines: past the 50 KB byte ceiling, under the 2000-line one.
	writeFileSync(file, `${"x".repeat(200)}\n`.repeat(300));
	await assert.rejects(
		() => provider().invoke("read", { path: file }, context),
		(error: Error) => {
			assert.match(error.message, /was truncated by pi's read limit/);
			assert.match(error.message, /254 of 300 lines/);
			assert.match(error.message, /continue from offset \d+/);
			assert.match(error.message, /pi\.bash \(rg\/sed\/jq\)/);
			return true;
		},
	);
});

test("a line too long to return at all says so", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spindle-read-line-"));
	const file = join(dir, "one-line.json");
	writeFileSync(file, "y".repeat(60 * 1024));
	await assert.rejects(() => provider().invoke("read", { path: file }, context), /first line alone is \d+ KB/);
});

test("a file inside the limit is returned whole, with no truncation notice", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spindle-read-small-"));
	const file = join(dir, "small.md");
	const content = `${"z".repeat(100)}\n`.repeat(50);
	writeFileSync(file, content);
	const result = await provider().invoke("read", { path: file }, context);
	assert.equal(result, content);
	assert.doesNotMatch(String(result), /Showing lines/);
});

test("paging with an explicit limit is not mistaken for truncation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spindle-read-page-"));
	const file = join(dir, "paged.md");
	writeFileSync(file, `${"w".repeat(80)}\n`.repeat(400));
	const result = await provider().invoke("read", { path: file, offset: 1, limit: 10 }, context);
	assert.match(String(result), /more lines in file/);
});
