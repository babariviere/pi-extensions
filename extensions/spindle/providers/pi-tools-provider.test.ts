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
const cappedProvider = (readMaxBytes: number) =>
	new PiToolsProvider(process.cwd(), undefined, undefined, undefined, { readMaxBytes });

test("a file past pi's read limit is returned whole, not as a head", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spindle-read-limit-"));
	const file = join(dir, "big.md");
	// 60 KB of short lines: past pi's 50 KB byte ceiling, under its 2000-line one.
	const content = `${"x".repeat(200)}\n`.repeat(300);
	writeFileSync(file, content);
	const result = await provider().invoke("read", { path: file }, context);
	assert.equal(result, content, "the sandbox is not the context window");
	assert.doesNotMatch(String(result), /Showing lines/);
});

test("a file past the sandbox ceiling is refused, with its size and the way out", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spindle-read-ceiling-"));
	const file = join(dir, "huge.md");
	writeFileSync(file, `${"x".repeat(200)}\n`.repeat(600)); // ~120 KB
	await assert.rejects(
		() => cappedProvider(64 * 1024).invoke("read", { path: file }, context),
		(error: Error) => {
			assert.match(error.message, /past the sandbox's 64 KB read ceiling/);
			assert.match(error.message, /executor\.readMaxBytes/);
			assert.match(error.message, /pi\.bash \(rg\/sed\/jq\)/);
			return true;
		},
	);
});

test("offset and limit still slice a widened read", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spindle-read-slice-"));
	const file = join(dir, "big.md");
	const lines = Array.from({ length: 500 }, (_, index) => `${index + 1}:${"x".repeat(200)}`);
	writeFileSync(file, lines.join("\n"));
	// The requested slice is itself ~60 KB, so pi truncates it and the sandbox
	// widens it: the slice the caller asked for has to survive that.
	const result = String(await provider().invoke("read", { path: file, offset: 10, limit: 300 }, context));
	assert.deepEqual(result.split("\n"), lines.slice(9, 309));
});

test("a single line too long for pi is returned whole too", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spindle-read-line-"));
	const file = join(dir, "one-line.json");
	const content = "y".repeat(60 * 1024);
	writeFileSync(file, content);
	// pi returns nothing at all for this shape (`firstLineExceedsLimit`), which is
	// what a minified JSON payload hits.
	assert.equal(await provider().invoke("read", { path: file }, context), content);
	await assert.rejects(
		() => cappedProvider(50 * 1024).invoke("read", { path: file }, context),
		/past the sandbox's 50 KB read ceiling/,
	);
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
