import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ClassifierContext, ClassifierModel } from "@earendil-works/pi-ai";
import { classifyClef, parseResult, wirePayload } from "./classifier.ts";
import { CLASSIFIER_API, MODEL_SPECS, normalizeClefConfig } from "./config.ts";

const context: ClassifierContext = {
	state: { message: "Checkout is down" },
	questions: {
		team: { type: "choice", instructions: "Which team?", criteria: { engineering: "Outages", billing: "Invoices" } },
		urgent: { type: "bool", instructions: "Is it urgent?", criteria: { true: "Outage", false: "Nonurgent" } },
		severity: { type: "score", instructions: "How severe?", criteria: ["None", "Some", "Severe"] },
	},
};
const response = {
	probabilities: {
		team: { engineering: 0.8, billing: 0.2 },
		urgent: { true: 0.9, false: 0.1 },
		severity: { "0": 0.1, "1": 0.2, "2": 0.7 },
	},
	inputTokens: 100,
};
const model: ClassifierModel<typeof CLASSIFIER_API> = {
	type: "classifier",
	provider: "clef",
	api: CLASSIFIER_API,
	id: MODEL_SPECS.flash.id,
	name: "Clef",
	baseUrl: "http://localhost/clef-stdio",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
};

test("Flash is the default; full has its own pinned snapshot and memory limit", () => {
	const defaults = normalizeClefConfig({});
	assert.equal(defaults.model, "flash");
	assert.equal(defaults.maxLength, 8192);
	assert.equal(defaults.memoryLimitGB, 16);
	assert.equal(defaults.idleTimeoutMs, 600_000);
	assert.equal(normalizeClefConfig({ model: "full" }).memoryLimitGB, 24);
	assert.equal(normalizeClefConfig({ python: "~/venv/bin/python" }).python, join(homedir(), "venv/bin/python"));
	assert.notEqual(MODEL_SPECS.flash.revision, MODEL_SPECS.full.revision);
});

test("invalid configuration fails closed", () => {
	for (const value of [
		{ python: null },
		{ modelPath: null },
		{ model: null },
		{ maxLength: null },
		{ model: "other" },
		{ modelPath: "relative" },
		{ python: "python3 -u" },
		{ python: "" },
		{ python: "foo\0bar" },
		{ maxLength: 16385 },
		{ idleTimeoutMs: 0 },
		{ memoryLimitGB: 3 },
		{ requestTimeoutMs: 1.5 },
		{ typo: true },
	])
		assert.throws(() => normalizeClefConfig(value), /clef.json/);
});

test("wire payload maps bool to noul and strips unsupported fields without mutating context", () => {
	const wire = wirePayload({ ...context, modelPath: "/arbitrary", command: "unload" }, 2);
	assert.deepEqual(Object.keys(wire).sort(), ["questions", "state", "temperature"]);
	assert.equal((wire.questions as Record<string, { type: string }>).urgent.type, "noul");
	assert.equal(context.questions.urgent.type, "bool");
	assert.equal(wire.temperature, 2);
});

test("question shapes and temperature are validated before invoking a worker", () => {
	for (const invalid of [
		{},
		{ state: [], questions: context.questions },
		{ state: {}, questions: {} },
		{ state: {}, questions: { q: { type: "bool", instructions: "", criteria: { true: "yes" } } } },
		{ state: {}, questions: { q: { type: "score", instructions: "", criteria: { a: "x" } } } },
		{ state: {}, questions: { q: { type: "choice", instructions: "", criteria: { a: 1 } } } },
		{ state: {}, questions: { q: { type: "other", instructions: "", criteria: { a: "x" } } } },
	])
		assert.throws(() => wirePayload(invalid));
	for (const temperature of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
		assert.throws(() => wirePayload(context, temperature));
});

test("joint probabilities become native answers and zero-cost input usage", () => {
	const result = parseResult(response, context);
	assert.deepEqual(result.answers.team, {
		type: "choice",
		choice: "engineering",
		confidence: 0.8,
		probabilities: response.probabilities.team,
	});
	assert.deepEqual(result.answers.urgent, { type: "bool", probability: 0.9 });
	const severity = result.answers.severity;
	assert.equal(severity.type, "score");
	if (severity.type === "score") {
		assert.ok(Math.abs(severity.score - 1.6) < 1e-10);
		assert.equal(severity.confidence, 0.7);
	}
	assert.equal(result.usage?.input, 100);
	assert.equal(result.usage?.output, 0);
	assert.equal(result.usage?.cost.total, 0);
});

test("malformed answers, labels, sums, and usage are rejected", () => {
	for (const value of [
		null,
		{},
		{ ...response, inputTokens: -1 },
		{ ...response, inputTokens: 1.5 },
		{ ...response, probabilities: { ...response.probabilities, team: { engineering: 1 } } },
		{ ...response, probabilities: { ...response.probabilities, team: { engineering: Number.NaN, billing: 0.2 } } },
		{ ...response, probabilities: { ...response.probabilities, team: { engineering: 0.2, billing: 0.2 } } },
		{ ...response, probabilities: { ...response.probabilities, team: { engineering: 1.1, billing: -0.1 } } },
	])
		assert.throws(() => parseResult(value, context));
});

test("classifier reports success, payload instrumentation, and transport options", async () => {
	const signal = new AbortController().signal;
	let called = false;
	const result = await classifyClef(
		model,
		context,
		{
			request: async (payload, options) => {
				called = true;
				assert.deepEqual(payload, wirePayload(context, 2));
				assert.equal(options?.signal, signal);
				assert.equal(options?.timeoutMs, 1000);
				return response;
			},
		},
		{
			signal,
			timeoutMs: 1000,
			temperature: 2,
			onPayload: (payload, entry) => {
				assert.equal(payload, context);
				assert.equal(entry, model);
			},
		},
	);
	assert.ok(called);
	assert.equal(result.stopReason, "stop");
	assert.equal(result.provider, "clef");
	assert.equal(result.model, MODEL_SPECS.flash.id);
	assert.equal(typeof result.timestamp, "number");
});

test("replacement payload is validated and parsed against its own schema", async () => {
	const replacement: ClassifierContext = {
		state: {},
		questions: { other: { type: "choice", instructions: "", criteria: { yes: "yes" } } },
	};
	const result = await classifyClef(
		model,
		context,
		{
			request: async (payload) => {
				assert.deepEqual(payload, wirePayload(replacement));
				return { probabilities: { other: { yes: 1 } }, inputTokens: 10 };
			},
		},
		{ onPayload: () => replacement },
	);
	assert.deepEqual(Object.keys(result.answers), ["other"]);
	const invalid = await classifyClef(
		model,
		context,
		{
			request: async () => {
				assert.fail("must not run");
			},
		},
		{ onPayload: () => ({}) },
	);
	assert.equal(invalid.stopReason, "error");
});

test("errors and aborted calls return native failure results; wrong model never starts", async () => {
	const failing = {
		request: async () => {
			throw new Error("offline checkpoint missing");
		},
	};
	const result = await classifyClef(model, context, failing);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "offline checkpoint missing");
	assert.deepEqual(result.answers, {});
	const aborted = await classifyClef(model, context, failing, { signal: AbortSignal.abort() });
	assert.equal(aborted.stopReason, "aborted");
	const wrong = await classifyClef({ ...model, id: MODEL_SPECS.full.id }, context, {
		request: async () => {
			assert.fail("must not run");
		},
	});
	assert.match(wrong.errorMessage!, /configured worker/);
	const full = await classifyClef(
		{ ...model, id: MODEL_SPECS.full.id },
		context,
		{ request: async () => response },
		undefined,
		MODEL_SPECS.full.id,
	);
	assert.equal(full.stopReason, "stop");
});
