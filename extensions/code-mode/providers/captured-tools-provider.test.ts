import assert from "node:assert/strict";
import { test } from "node:test";

import type { CapturedToolCatalog, CapturedToolEntry } from "../capture/catalog.ts";
import { ActionRegistry } from "../core/action-registry.ts";
import { CapturedToolsProvider } from "./captured-tools-provider.ts";

const context = {} as any;
const listRequest = {} as any;

const entry = (name: string): CapturedToolEntry =>
	({
		name,
		definition: { name, description: `${name} tool`, parameters: { type: "object" } },
		sourceInfo: { path: `/ext/${name}.ts`, source: "cli", scope: "user", origin: "top-level" },
	}) as unknown as CapturedToolEntry;

/** Only list/get/require are exercised by the provider. */
const catalog = (...entries: CapturedToolEntry[]): CapturedToolCatalog =>
	({
		list: () => entries,
		get: (name: string) => entries.find((candidate) => candidate.name === name),
		require: (name: string) => {
			const found = entries.find((candidate) => candidate.name === name);
			if (!found) throw new Error(`Unknown captured extension tool: ${name}`);
			return found;
		},
	}) as unknown as CapturedToolCatalog;

const tools = catalog(entry("fetch_content"), entry("todo"), entry("web_search"));

const provider = (aliases: Readonly<Record<string, string>> = { search: "web_search", fetch: "fetch_content" }) =>
	new CapturedToolsProvider(tools, undefined, { aliases });

test("the provider lists only explicitly registered aliases", async () => {
	const names = (await provider().list(listRequest, context)).map((descriptor) => descriptor.name);
	assert.deepEqual(names.sort(), ["fetch", "search"]);
});

test("list filters by query", async () => {
	const names = (await provider().list({ query: "search" } as any, context)).map((descriptor) => descriptor.name);
	assert.deepEqual(names, ["search"]);
});

test("describe returns undefined for a tool that was never captured", async () => {
	assert.equal(await provider().describe("nope", context), undefined);
});

test("describe resolves a captured tool", async () => {
	const descriptor = await provider().describe("search", context);
	assert.equal(descriptor?.name, "search");
});

test("unmapped captured names are unavailable, including inherited property names", async () => {
	const web = provider();
	for (const name of ["web_search", "todo", "toString", "constructor", "__proto__"]) {
		assert.equal(await web.describe(name, context), undefined, name);
		assert.throws(() => web.prepareArguments(name, {}), /Unknown captured extension tool/);
		await assert.rejects(() => web.invoke(name, {}, context), /Unknown captured extension tool/);
	}
});

test("an inherited alias registration is not treated as explicit", async () => {
	const aliases = Object.create({ search: "web_search" }) as Record<string, string>;
	const web = provider(aliases);
	assert.deepEqual(await web.list(listRequest, context), []);
	assert.equal(await web.describe("search", context), undefined);
});

test("registry generic dispatch rejects raw and unmapped captured names", async () => {
	const registry = new ActionRegistry();
	registry.register(provider());
	const registryContext = {
		cwd: "/tmp",
		signal: undefined,
		parentToolCallId: "test",
		nestedToolCallId: "nested",
		extensionContext: context,
		update: () => {},
		audits: [],
		maxResultChars: 10_000,
	};
	for (const ref of ["web.web_search", "web.todo", "web.toString", "web.__proto__"]) {
		await assert.rejects(() => registry.invoke(ref, {}, registryContext), /Unknown Spindle action/);
	}
});
