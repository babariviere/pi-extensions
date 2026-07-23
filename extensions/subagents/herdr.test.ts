import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	findAgentStatus,
	isPaneBusyError,
	paneLabel,
	parseHerdrJson,
	parsePaneId,
	parseTab,
	parseTabs,
	runHerdr,
	startAgent,
} from "./herdr.ts";

/** Install a fake `herdr` on PATH that runs `body` (a /bin/sh snippet). */
function withFakeHerdr<T>(body: string, fn: () => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "fake-herdr-"));
	writeFileSync(join(dir, "herdr"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	const prevPath = process.env.PATH;
	process.env.PATH = `${dir}:${prevPath ?? ""}`;
	return fn().finally(() => {
		process.env.PATH = prevPath;
	});
}

test("runHerdr treats a clean exit with empty stdout as success", async () => {
	const res = await withFakeHerdr("exit 0", () => runHerdr(["pane", "run", "wA:p1", "echo hi"]));
	assert.equal(res.ok, true);
	assert.deepEqual(res.result, {});
});

test("runHerdr reports failure when the command exits non-zero", async () => {
	const res = await withFakeHerdr("echo boom 1>&2; exit 1", () => runHerdr(["pane", "run", "wA:p1", "x"]));
	assert.equal(res.ok, false);
	assert.match(res.error ?? "", /boom/);
});

test("runHerdr parses JSON stdout on success", async () => {
	const res = await withFakeHerdr(`echo '{"id":"x","result":{"pane_id":"wA:p9"}}'`, () =>
		runHerdr(["pane", "get", "wA:p9"]),
	);
	assert.equal(res.ok, true);
	assert.deepEqual(res.result, { pane_id: "wA:p9" });
});


test("parseHerdrJson reads the JSON line and extracts result", () => {
	const out = parseHerdrJson('{"id":"cli:tab:list","result":{"tabs":[]}}');
	assert.equal(out?.ok, true);
	assert.deepEqual(out?.result, { tabs: [] });
});

test("parseHerdrJson tolerates leading log lines", () => {
	const out = parseHerdrJson('some log\nanother line\n{"id":"x","result":{"pane_id":"wA:p3"}}');
	assert.equal(out?.ok, true);
	assert.deepEqual(out?.result, { pane_id: "wA:p3" });
});

test("parseHerdrJson surfaces errors and returns undefined for non-json", () => {
	const err = parseHerdrJson('{"id":"x","error":{"message":"boom"}}');
	assert.equal(err?.ok, false);
	assert.equal(err?.error, "boom");
	assert.equal(parseHerdrJson("no json here"), undefined);
	assert.equal(parseHerdrJson(""), undefined);
});

test("parseTabs is tolerant of field-name variation", () => {
	const tabs = parseTabs({
		tabs: [
			{ tab_id: "wA:t1", label: "subagents", workspace_id: "wA" },
			{ tabId: "wA:t2", label: "other" },
			{ nope: true },
		],
	});
	assert.equal(tabs.length, 2);
	assert.equal(tabs[0].tabId, "wA:t1");
	assert.equal(tabs[0].label, "subagents");
	assert.equal(tabs[0].workspaceId, "wA");
	assert.equal(tabs[1].tabId, "wA:t2");
});

test("parseTab reads direct and nested tab objects", () => {
	assert.equal(parseTab({ tab_id: "wA:t5", label: "x" })?.tabId, "wA:t5");
	assert.equal(parseTab({ tab: { tab_id: "wA:t6" } })?.tabId, "wA:t6");
	assert.equal(parseTab({}), undefined);
});

test("parseTab captures the root pane id from a tab create response", () => {
	const tab = parseTab({ tab: { tab_id: "wA:t7", label: "subagents" }, root_pane: { pane_id: "wA:pC" } });
	assert.equal(tab?.tabId, "wA:t7");
	assert.equal(tab?.rootPaneId, "wA:pC");
	assert.equal(parseTab({ tab_id: "wA:t8" })?.rootPaneId, undefined);
});

test("paneLabel combines the agent name with a clamped single-line task slug", () => {
	assert.equal(paneLabel("worker", ""), "worker");
	assert.equal(paneLabel("worker", "   "), "worker");
	assert.equal(paneLabel("worker", "fix the bug"), "worker \u00b7 fix the bug");
	assert.equal(paneLabel("worker", "line one\nline two\ttabbed"), "worker \u00b7 line one line two tabbed");
	const long = paneLabel("reviewer", "a".repeat(80), 10);
	assert.equal(long, `reviewer \u00b7 ${"a".repeat(10)}\u2026`);
});

test("findAgentStatus locates agent_status at any nesting depth", () => {
	assert.equal(findAgentStatus({ agent_status: "idle" }), "idle");
	assert.equal(findAgentStatus({ pane: { agent_status: "working" } }), "working");
	assert.equal(findAgentStatus({ result: { panes: [{ agent_status: "done" }] } }), "done");
	assert.equal(findAgentStatus({ nope: true }), undefined);
	assert.equal(findAgentStatus(null), undefined);
});

test("parsePaneId reads direct and nested pane ids", () => {
	assert.equal(parsePaneId({ pane_id: "wA:p1" }), "wA:p1");
	assert.equal(parsePaneId({ pane: { pane_id: "wA:p2" } }), "wA:p2");
	assert.equal(parsePaneId({ agent: { paneId: "wA:p3" } }), "wA:p3");
	assert.equal(parsePaneId({}), undefined);
});

test("isPaneBusyError matches herdr's pane-busy rejections only", () => {
	assert.equal(isPaneBusyError("agent target pane wA:p1 is not an available shell"), true);
	assert.equal(isPaneBusyError("agent_pane_busy"), true);
	assert.equal(isPaneBusyError("agent pane busy"), true);
	assert.equal(isPaneBusyError("unsupported interactive agent kind foo"), false);
	assert.equal(isPaneBusyError("agent target pane wA:p1 not found"), false);
	assert.equal(isPaneBusyError(undefined), false);
});

test("startAgent retries while the pane is busy, then succeeds", async () => {
	const counter = join(mkdtempSync(join(tmpdir(), "start-agent-")), "n");
	const body = [
		`c=$(cat "${counter}" 2>/dev/null || echo 0)`,
		`echo $((c + 1)) > "${counter}"`,
		`if [ "$c" -lt 2 ]; then`,
		`  echo '{"id":"x","error":{"message":"agent target pane wA:p1 is not an available shell"}}'`,
		`else`,
		`  echo '{"id":"x","result":{}}'`,
		`fi`,
	].join("\n");
	const res = await withFakeHerdr(body, () =>
		startAgent("sub-0-abc", "pi", "wA:p1", ["--flag"], 60000, { pollMs: 1, readyTimeoutMs: 5000 }),
	);
	assert.equal(res.ok, true);
});

test("startAgent times out with a clear error when the pane stays busy", async () => {
	const body = `echo '{"id":"x","error":{"message":"agent target pane wA:p1 is not an available shell"}}'`;
	const res = await withFakeHerdr(body, () =>
		startAgent("sub-0-abc", "pi", "wA:p1", ["--flag"], 60000, { pollMs: 1, readyTimeoutMs: 30 }),
	);
	assert.equal(res.ok, false);
	assert.match(res.error ?? "", /wA:p1 did not become ready/);
	assert.match(res.error ?? "", /within 30ms/);
	assert.match(res.error ?? "", /not an available shell/);
});

test("startAgent fails fast on a non-busy error without retrying", async () => {
	const body = `echo '{"id":"x","error":{"message":"unsupported interactive agent kind foo"}}'`;
	const res = await withFakeHerdr(body, () =>
		startAgent("sub-0-abc", "foo", "wA:p1", ["--flag"], 60000, { pollMs: 1, readyTimeoutMs: 5000 }),
	);
	assert.equal(res.ok, false);
	assert.match(res.error ?? "", /unsupported interactive agent kind/);
});
