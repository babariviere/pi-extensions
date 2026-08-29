import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { PI_CORE_TOOL_NAMES } from "../core/pi-tools.ts";
import { SpindleToolGate } from "../core/tool-allowlist.ts";
import { PiToolsProvider } from "./pi-tools-provider.ts";

const context = {} as any;
const listRequest = {} as any;

const provider = (allowed?: string[]) =>
	new PiToolsProvider(process.cwd(), undefined, undefined, SpindleToolGate.of(allowed ? new Set(allowed) : undefined));

const names = async (allowed?: string[]): Promise<string[]> =>
	(await provider(allowed).list(listRequest, context)).map((descriptor) => descriptor.name);

test("an unrestricted provider lists every pi core tool", async () => {
	assert.deepEqual((await names()).sort(), [...PI_CORE_TOOL_NAMES].sort());
});

test("list hides the tools a subagent's allowlist excludes", async () => {
	assert.deepEqual((await names(["read", "grep"])).sort(), ["grep", "read"]);
	assert.deepEqual(await names([]), []);
});

test("describe resolves an allowed tool", async () => {
	const descriptor = await provider(["read"]).describe("read", context);
	assert.equal(descriptor?.name, "read");
	assert.ok(descriptor?.inputSchema);
});

test("describe throws the restriction error for a disallowed tool", async () => {
	// ActionRegistry.invoke() resolves through describe(), so returning undefined
	// here would surface as "Unknown Spindle action" and read like a typo.
	await assert.rejects(
		() => provider(["read", "grep"]).describe("bash", context),
		/Tool pi\.bash is not in this agent's tool allowlist \(allowed: grep, read\)/,
	);
});

test("describe still returns undefined for a tool that does not exist", async () => {
	assert.equal(await provider(["read"]).describe("nope", context), undefined);
	assert.equal(await provider().describe("nope", context), undefined);
});

test("invoke rejects a disallowed tool before running it", async () => {
	await assert.rejects(
		() => provider(["read"]).invoke("bash", { command: "echo unreachable" }, context),
		/not in this agent's tool allowlist/,
	);
});

test("invoke still reports an unknown tool as unknown", async () => {
	await assert.rejects(() => provider(["read"]).invoke("nope", {}, context), /Unknown Pi tool: nope/);
});

test("prepareArguments rejects a disallowed tool", () => {
	assert.throws(
		() => provider(["read"]).prepareArguments("bash", { command: "echo unreachable" }),
		/not in this agent's tool allowlist/,
	);
});

const guardedProvider = (readGuard: (absolutePath: string) => void) =>
	new PiToolsProvider(process.cwd(), undefined, undefined, SpindleToolGate.of(undefined), { readGuard });

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

test("an unrestricted provider gates nothing", async () => {
	const unrestricted = provider();
	assert.equal((await unrestricted.describe("bash", context))?.name, "bash");
	assert.doesNotThrow(() => unrestricted.prepareArguments("bash", { command: "true" }));
});
