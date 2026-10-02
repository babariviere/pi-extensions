import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionVirtualModel, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import router, { chooseRoute, normalizeRouterConfig, routingCandidates } from "./index.ts";

function model(id: string, rate: number, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		provider: "test",
		api: "openai-responses",
		name: id,
		reasoning: true,
		baseUrl: "https://example.invalid",
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_000,
		cost: { input: rate, output: rate, cacheRead: 0, cacheWrite: 0 },
		...extra,
	};
}
const cheap = model("cheap", 1);
const strong = model("strong", 10);
const virtual = model("auto", 0, { api: "pi-virtual", provider: "router" });
const request = (extra: Partial<ModelRouteRequest> = {}): ModelRouteRequest => ({
	model: virtual,
	reason: "user",
	thinkingLevel: "low",
	messages: [],
	...extra,
});

test("registration is opt-in and never changes the current selection", () => {
	let definition: ExtensionVirtualModel | undefined;
	router({
		registerVirtualModel: (value: ExtensionVirtualModel) => {
			definition = value;
		},
	} as ExtensionAPI);
	assert.equal(definition?.provider, "router");
	assert.equal(definition?.id, "auto");
	assert.equal(typeof definition?.route, "function");
});

test("candidates intersect authenticated physical models with the configured scope", () => {
	const unauthenticated = model("missing", 0.1);
	assert.deepEqual(routingCandidates([virtual, cheap, strong], []), [cheap, strong]);
	assert.deepEqual(
		routingCandidates([virtual, cheap, strong], [{ model: virtual }, { model: strong }, { model: unauthenticated }]),
		[strong],
	);
	assert.deepEqual(routingCandidates([virtual, cheap], [{ model: virtual }]), []);
});

test("automatic price selection skips zero, missing, invalid and negative prices", () => {
	const free = model("local", 0);
	const invalid = model("invalid", Number.NaN);
	const negative = model("negative", -1);
	assert.equal(chooseRoute(request(), [strong, free, invalid, negative, cheap], {}).model, cheap);
	assert.throws(() => chooseRoute(request(), [free, invalid, negative], {}), /no priced physical model/);
	assert.equal(chooseRoute(request(), [free, cheap], { cheapModel: "test/local" }).model, free);
});

test("equal prices have deterministic ordering independent of catalog order", () => {
	const a = model("a", 1),
		b = model("b", 1);
	assert.equal(chooseRoute(request(), [b, a], {}).model, a);
});

test("high effort requires an explicit strong model, not an expensive-model guess", () => {
	for (const thinkingLevel of ["high", "xhigh", "max"] as const) {
		assert.throws(() => chooseRoute(request({ thinkingLevel }), [cheap, strong], {}), /configure strongModel/);
		assert.deepEqual(chooseRoute(request({ thinkingLevel }), [cheap, strong], { strongModel: "test/strong" }), {
			model: strong,
			thinkingLevel,
		});
	}
});

test("explicit roles cannot escape the scope and authentication intersection", () => {
	assert.throws(() => chooseRoute(request(), [strong], { cheapModel: "test/cheap" }), /not authenticated, in scope/);
	assert.throws(() => chooseRoute(request(), [], {}), /add authenticated physical models/);
});

test("continuations preserve the physical model and thinking, even when selection changes", () => {
	const previous = { model: strong, thinkingLevel: "high" as const };
	assert.deepEqual(
		chooseRoute(request({ reason: "continuation", previous }), [cheap, strong], { cheapModel: "test/cheap" }),
		previous,
	);
	assert.throws(
		() => chooseRoute(request({ reason: "continuation", previous }), [cheap], {}),
		/no longer available in scope/,
	);
});

test("retry prefers the failed route over the last successful response", () => {
	const previous = { model: cheap, thinkingLevel: "low" as const };
	const failed = { model: strong, thinkingLevel: "high" as const, message: {} as never };
	assert.deepEqual(chooseRoute(request({ reason: "retry", previous, failed }), [cheap, strong], {}), {
		model: strong,
		thinkingLevel: "high",
	});
	assert.deepEqual(chooseRoute(request({ reason: "retry", previous }), [cheap, strong], {}), previous);
});

test("direct model calls choose the direct role with thinking off and no state", () => {
	assert.deepEqual(
		chooseRoute(
			request({ reason: "direct", thinkingLevel: "high", previous: { model: strong } }),
			[cheap, strong],
			{},
		),
		{ model: cheap, thinkingLevel: "off" },
	);
	assert.equal(
		chooseRoute(request({ reason: "direct" }), [cheap, strong], { directModel: "test/strong" }).model,
		strong,
	);
});

test("images require a compatible model for a new route", () => {
	const vision = model("vision", 2, { input: ["text", "image"] });
	const imageRequest = request({
		messages: [{ role: "user", timestamp: 0, content: [{ type: "image", data: "", mimeType: "image/png" }] }],
	});
	assert.equal(chooseRoute(imageRequest, [cheap, vision], {}).model, vision);
	assert.throws(() => chooseRoute(imageRequest, [cheap], { cheapModel: "test/cheap" }), /compatible with image input/);
});

test("cancellation is honored before routing", () => {
	const controller = new AbortController();
	controller.abort(new Error("cancelled"));
	assert.throws(() => chooseRoute(request({ signal: controller.signal }), [cheap], {}), /cancelled/);
});

test("configuration validates exact qualified IDs and keeps optional roles optional", () => {
	assert.deepEqual(normalizeRouterConfig({ cheapModel: "openrouter/acme/model" }), {
		cheapModel: "openrouter/acme/model",
	});
	assert.deepEqual(normalizeRouterConfig({}), {});
	for (const cheapModel of [42, "cheap", " test/cheap", "test/cheap with spaces", "test/*", "test/cheap?", null])
		assert.throws(() => normalizeRouterConfig({ cheapModel }), /exact provider\/model/);
});
