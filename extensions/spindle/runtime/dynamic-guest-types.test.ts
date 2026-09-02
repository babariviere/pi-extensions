import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDynamicGuestDeclarations } from "./dynamic-guest-types.ts";
import { guestTypeDeclarations } from "./guest-types.ts";
import { typeCheckSpindleCode } from "./type-checker.ts";

const searchTool = {
	name: "web_search",
	inputSchema: {
		type: "object",
		properties: { query: { type: "string" }, limit: { type: "number" } },
		required: ["query"],
		additionalProperties: false,
	},
};

test("an empty source set keeps the loose declarations", () => {
	assert.deepEqual(buildDynamicGuestDeclarations({}), {});
	assert.deepEqual(buildDynamicGuestDeclarations({ extensionTools: [] }), {});
});

test("extension tools render with their declared schemas", () => {
	const dynamic = buildDynamicGuestDeclarations({ extensionTools: [searchTool] });
	assert.match(String(dynamic.extensions), /web_search\(args: \{ limit\?: number; query: string \}\)/);
	assert.match(String(dynamic.extensions), /declare const extensions: SpindleExtensionsApiDynamic;/);
});

test("non-identifier tool names render as quoted members", () => {
	const dynamic = buildDynamicGuestDeclarations({
		extensionTools: [{ name: "linear-issue", inputSchema: { type: "object", properties: {} } }],
	});
	assert.match(String(dynamic.extensions), /"linear-issue"\(args\?:/);
});

test("the generated surface replaces the loose declaration and gates bad arguments", () => {
	const declarations = guestTypeDeclarations(
		true,
		buildDynamicGuestDeclarations({
			extensionTools: [searchTool],
		}),
	);
	assert.equal(declarations.includes("declare const extensions: SpindleExtensionsApi;\n"), false);

	const good = typeCheckSpindleCode("return await extensions.web_search({ query: 'x' });", declarations);
	assert.deepEqual(good.errors, []);

	const bad = typeCheckSpindleCode("return await extensions.web_search({ quer: 'x' });", declarations);
	assert.ok(bad.errors.length > 0);
	assert.match(bad.errors[0]!.message, /quer/);
});
