import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { HOST_CALLS } from "../host-calls.ts";
import { QuickJsRuntime } from "./quickjs-runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeSource = readFileSync(join(here, "quickjs-runtime.ts"), "utf8");
const serviceSource = readFileSync(join(here, "..", "execution-service.ts"), "utf8");
const hostCallsSource = readFileSync(join(here, "..", "host-calls.ts"), "utf8");

/** Host calls the dispatch table answers (see ../host-calls.ts). */
const serviceCaseRefs = new Set(HOST_CALLS.map((call) => call.ref));

/** Host calls the runtime itself satisfies before the bridge is reached. */
const runtimeInternalRefs = new Set([...runtimeSource.matchAll(/reference === "([^"]+)"/g)].map((match) => match[1]!));

/**
 * Every literal ref GUEST_SETUP can emit through `__call`. The trailing
 * comma keeps concatenated prefixes (`__call("pi." + name, ...)`) out: those
 * are dynamic refs covered by the provider-namespace check instead.
 */
const guestStaticRefs = new Set([...runtimeSource.matchAll(/__call\("([^"]+)",/g)].map((match) => match[1]!));

/** Host-call cases with no guest producer today (kept for API completeness). */
const HOST_ONLY_REFS = new Set(["spindle.$progress"]);

/** Provider namespaces the registry can resolve a default-dispatch ref to. */
const REGISTRY_PROVIDERS = new Set(["pi", "extensions", "mcp", "agents"]);

/** Exercise every guest API surface with a recording host bridge. */
const probeCode = [
	"await pi.read('/x');",
	"await extensions.anything({});",
	"await tools.providers();",
	"await tools.catalog();",
	"await tools.list();",
	"await tools.search({ query: 'x' });",
	"await tools.describe({ ref: 'pi.read' });",
	"await tools.call({ ref: 'pi.read', args: {} });",
	"await mcp.list(); await mcp.search({ query: 'x' }); await mcp.describe({ tool: 'x' });",
	"await mcp.call('s', 't', {}); await mcp.connect('s'); await mcp.srv.tool(); await mcp.srv();",
	"await agents.list(); await agents.run({ agent: 'a', task: 't' }); await agents.runAll({ tasks: [] });",
	"await workflow.phase('p'); await workflow.item({ label: 'x' }); await workflow.event({ message: 'x' });",
	"await workflow.configure({ name: 'x' });",
	"await workflow.parallel([1], (x) => x);",
	"await workflow.pipeline([1], (x) => x);",
	"await new Promise((resolve) => setTimeout(resolve, 1));",
	"print('hi');",
].join("\n");

test("the host-call table has exactly one entry per ref", () => {
	assert.equal(serviceCaseRefs.size, HOST_CALLS.length);
});

test("every static ref GUEST_SETUP can emit is exercised by the probe", async () => {
	const recorded = new Set<string>();
	const result = await new QuickJsRuntime().execute(
		probeCode,
		async (ref) => {
			recorded.add(ref);
			return {};
		},
		{ timeoutMs: 10_000, memoryLimitBytes: 64 * 1024 * 1024 },
	);
	assert.equal(result.terminationReason, "completed");
	// spindle.$timer never reaches the bridge: the runtime satisfies it itself.
	for (const ref of guestStaticRefs) {
		assert.ok(recorded.has(ref) || runtimeInternalRefs.has(ref), `probe must exercise guest ref ${ref}`);
	}
});

test("every guest ref is handled by the host", async () => {
	const recorded = new Set<string>();
	const result = await new QuickJsRuntime().execute(
		probeCode,
		async (ref) => {
			recorded.add(ref);
			return {};
		},
		{ timeoutMs: 10_000, memoryLimitBytes: 64 * 1024 * 1024 },
	);
	assert.equal(result.terminationReason, "completed");
	assert.ok(recorded.size > 0);
	for (const ref of recorded) {
		const handled =
			serviceCaseRefs.has(ref) ||
			runtimeInternalRefs.has(ref) ||
			(ref.includes(".") && REGISTRY_PROVIDERS.has(ref.slice(0, ref.indexOf("."))));
		assert.ok(handled, `unhandled guest ref: ${ref}`);
	}
});

test("every static host-call case is reachable from the guest", async () => {
	const recorded = new Set<string>();
	const result = await new QuickJsRuntime().execute(
		probeCode,
		async (ref) => {
			recorded.add(ref);
			return {};
		},
		{ timeoutMs: 10_000, memoryLimitBytes: 64 * 1024 * 1024 },
	);
	assert.equal(result.terminationReason, "completed");
	for (const ref of serviceCaseRefs) {
		assert.ok(recorded.has(ref) || HOST_ONLY_REFS.has(ref), `host-call table entry ${ref} has no guest producer`);
	}
});

test("the vendored rename left no fabric host-call refs", () => {
	assert.ok(!/fabric\.\$/.test(runtimeSource), "quickjs-runtime.ts still names fabric.$ refs");
	assert.ok(!/fabric\.\$/.test(serviceSource), "execution-service.ts still names fabric.$ refs");
	assert.ok(!/fabric\.\$/.test(hostCallsSource), "host-calls.ts still names fabric.$ refs");
});
