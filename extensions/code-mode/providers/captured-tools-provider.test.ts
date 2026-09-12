import assert from "node:assert/strict";
import { test } from "node:test";

import type { CapturedToolCatalog, CapturedToolEntry } from "../capture/catalog.ts";
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

const provider = () => new CapturedToolsProvider(tools);

test("the provider lists every captured tool", async () => {
	const names = (await provider().list(listRequest, context)).map((descriptor) => descriptor.name);
	assert.deepEqual(names.sort(), ["fetch_content", "todo", "web_search"]);
});

test("list filters by query", async () => {
	const names = (await provider().list({ query: "search" } as any, context)).map((descriptor) => descriptor.name);
	assert.deepEqual(names, ["web_search"]);
});

test("describe returns undefined for a tool that was never captured", async () => {
	assert.equal(await provider().describe("nope", context), undefined);
});

test("describe resolves a captured tool", async () => {
	const descriptor = await provider().describe("todo", context);
	assert.equal(descriptor?.name, "todo");
});
