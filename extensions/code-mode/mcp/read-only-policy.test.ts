import assert from "node:assert/strict";
import { test } from "node:test";

import {
	assertMcpGatewayArguments,
	classifyMcpToolName,
	DEFAULT_MCP_READ_ONLY_CONFIG,
	decideMcpCall,
	effectiveMcpReadOnlyConfig,
	McpReadOnlyGate,
	mcpToolNameVariants,
	normalizeMcpReadOnlyConfig,
} from "./read-only-policy.ts";

/** Night mode: the master switch on, everything else at its default. */
const nightGate = (): McpReadOnlyGate =>
	McpReadOnlyGate.of(effectiveMcpReadOnlyConfig(DEFAULT_MCP_READ_ONLY_CONFIG, true));

const allowed = (tool: string, server?: string): boolean => nightGate().decide(tool, server).allowed;

test("read-only mode off lets every MCP call through", () => {
	const gate = McpReadOnlyGate.of(DEFAULT_MCP_READ_ONLY_CONFIG);
	assert.equal(gate.readOnly, false);
	assert.equal(gate.decide("slack_send_message", "slack").allowed, true);
	gate.assert("slack_send_message", "slack");
});

test("the classifier reads tool names, not the model's mind", () => {
	assert.equal(classifyMcpToolName("slack_send_message"), "write");
	assert.equal(classifyMcpToolName("slack_add_reaction"), "write");
	assert.equal(classifyMcpToolName("save_issue"), "write");
	assert.equal(classifyMcpToolName("CREATE_NEW_CARD"), "write");
	assert.equal(classifyMcpToolName("saveComment"), "write");
	assert.equal(classifyMcpToolName("slack_read_thread"), "read");
	assert.equal(classifyMcpToolName("search_datadog_monitors"), "read");
	// A read whose name carries no verb we recognise: unknown, not read.
	assert.equal(classifyMcpToolName("_dd_gff"), "unknown");
	assert.equal(classifyMcpToolName("USAGE_GUIDE"), "unknown");
	// `reactions` is not `react`: whole segments are matched, never substrings.
	assert.equal(classifyMcpToolName("slack_get_reactions"), "read");
});

test("slack is total in night read-only mode", () => {
	for (const tool of [
		"slack_send_message",
		"slack_send_message_draft",
		"slack_schedule_message",
		"slack_add_reaction",
		"slack_create_conversation",
		"slack_create_canvas",
		"slack_update_canvas",
		// Not in the catalog today; a new visible-artifact tool must fail closed.
		"slack_delete_message",
		"slack_reply_in_thread",
		"slack_set_bookmark",
		"slack_invent_something",
	]) {
		assert.equal(allowed(tool, "slack"), false, `${tool} must be refused`);
	}
});

test("slack reads still work at night", () => {
	for (const tool of [
		"slack_search_public",
		"slack_search_public_and_private",
		"slack_search_channels",
		"slack_search_users",
		"slack_read_channel",
		"slack_read_thread",
		"slack_read_canvas",
		"slack_read_user_profile",
		"slack_list_channel_members",
		"slack_read_file",
		"slack_search_emojis",
		"slack_get_reactions",
	]) {
		assert.equal(allowed(tool, "slack"), true, `${tool} must be allowed`);
	}
});

test("linear reads are allowed and linear mutations are refused", () => {
	for (const tool of ["get_issue", "list_issues", "list_comments", "get_project", "list_teams", "get_user"]) {
		assert.equal(allowed(tool, "linear"), true, `${tool} must be allowed`);
	}
	// `save_issue` is the exception, decided on its payload; see the create-only
	// tests below.
	for (const tool of [
		"save_comment",
		"delete_comment",
		"save_project",
		"save_status_update",
		"submit_diff_review",
		"merge_diff",
		"share_issue",
		"create_issue_label",
	]) {
		assert.equal(allowed(tool, "linear"), false, `${tool} must be refused`);
	}
});

test("datadog reads are allowed and datadog mutations are refused", () => {
	for (const tool of [
		"search_datadog_logs",
		"search_datadog_monitors",
		"get_datadog_dashboard",
		"get_datadog_incident",
		"aggregate_spans",
		"analyze_datadog_logs",
		"_dd_gff",
	]) {
		assert.equal(allowed(tool, "datadog"), true, `${tool} must be allowed`);
	}
	for (const tool of [
		"update_datadog_monitor",
		"delete_datadog_monitor",
		"mute_datadog_monitor",
		"create_datadog_dashboard",
		"update_datadog_incident",
		"post_datadog_event",
	]) {
		assert.equal(allowed(tool, "datadog"), false, `${tool} must be refused`);
	}
});

test("metabase reads are allowed, card writes and raw SQL are refused", () => {
	assert.equal(allowed("LIST_DASHBOARDS", "metabase"), true);
	assert.equal(allowed("GET_CARD_DATA", "metabase"), true);
	assert.equal(allowed("CREATE_NEW_CARD", "metabase"), false);
	assert.equal(allowed("UPDATE_CARD", "metabase"), false);
	assert.equal(allowed("EXECUTE_SQL_QUERY", "metabase"), false);
});

test("an unqualified tool name is judged against the server that owns it", () => {
	const decision = nightGate().decide("slack_send_message");
	assert.equal(decision.allowed, false);
	assert.equal(decision.server, "slack");
	assert.equal(nightGate().decide("save_issue").server, "linear");
});

test("unknown tools on an unknown server are denied by default", () => {
	const decision = nightGate().decide("whatever_tool", "mystery");
	assert.equal(decision.allowed, false);
	assert.equal(decision.rule, "unknown-tool");
});

test("unknownToolPolicy allow-reads falls back to the read heuristic", () => {
	const gate = McpReadOnlyGate.of({
		...DEFAULT_MCP_READ_ONLY_CONFIG,
		readOnly: true,
		unknownToolPolicy: "allow-reads",
	});
	assert.equal(gate.decide("get_file_contents", "github").allowed, true);
	assert.equal(gate.decide("merge_pull_request", "github").allowed, false);
	assert.equal(gate.decide("weird_thing", "github").allowed, false);
});

test("an explicit allow entry beats the write heuristic, a deny entry beats everything", () => {
	const gate = McpReadOnlyGate.of({
		...DEFAULT_MCP_READ_ONLY_CONFIG,
		readOnly: true,
		servers: {
			datadog: { allow: ["post_datadog_query"] },
			// `default: "allow"` exempts the server, but the deny list still wins.
			mystery: { default: "allow", deny: ["nuke_everything"] },
		},
	});
	assert.equal(gate.decide("post_datadog_query", "datadog").allowed, true);
	assert.equal(gate.decide("anything_at_all", "mystery").allowed, true);
	assert.equal(gate.decide("nuke_everything", "mystery").allowed, false);
	// A user allow list adds to the built-in one, it does not replace the denies.
	assert.equal(gate.decide("update_datadog_monitor", "datadog").allowed, false);
});

test("a refusal names the tool, the server and the way out", () => {
	assert.throws(
		() => nightGate().assert("slack_send_message", "slack"),
		(error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			assert.match(message, /MCP call slack\.slack_send_message is refused/);
			assert.match(message, /read-only MCP mode is on and it is on the deny list for server 'slack'/);
			assert.match(message, /mcp\.servers\.slack\.allow in spindle\.json/);
			return true;
		},
	);
});

test("the gateway argument shape is gated, management shapes are not", () => {
	const gate = nightGate();
	assert.throws(() => assertMcpGatewayArguments(gate, { tool: "save_issue", args: { id: "HS-829" } }), /is refused/);
	assert.throws(
		() => assertMcpGatewayArguments(gate, { tool: "slack_send_message", server: "slack", args: {} }),
		/is refused/,
	);
	assertMcpGatewayArguments(gate, { tool: "get_issue", server: "linear", args: {} });
	assertMcpGatewayArguments(gate, { search: "issue" });
	assertMcpGatewayArguments(gate, { describe: "save_issue" });
	assertMcpGatewayArguments(gate, { connect: "linear" });
	assertMcpGatewayArguments(gate, {});
});

test("the night floor cannot be loosened by configuration", () => {
	const config = normalizeMcpReadOnlyConfig({ readOnly: false, unknownToolPolicy: "allow" });
	assert.equal(config.readOnly, false);
	const night = effectiveMcpReadOnlyConfig(config, true);
	assert.equal(night.readOnly, true);
	// `unknownToolPolicy: "allow"` stays configurable; only the switch is a floor.
	assert.equal(McpReadOnlyGate.of(night).decide("slack_send_message", "slack").allowed, false);
});

test("normalization ignores junk and keeps the defaults", () => {
	assert.deepEqual(normalizeMcpReadOnlyConfig(undefined), DEFAULT_MCP_READ_ONLY_CONFIG);
	assert.deepEqual(normalizeMcpReadOnlyConfig({ readOnly: "yes", unknownToolPolicy: "maybe", servers: 3 }), {
		readOnly: false,
		unknownToolPolicy: "deny",
		defaultServerPolicy: "deny-writes",
		servers: {},
	});
	assert.deepEqual(
		normalizeMcpReadOnlyConfig({ servers: { slack: { allow: ["a", 2, " b "], deny: null } } }).servers,
		{
			slack: { allow: ["a", "b"] },
		},
	);
});

/**
 * Regression: the subagent path. pi-mcp-adapter registers tools under
 * server-prefixed names, so this is the name shape the guard really sees, and
 * the shape that used to be refused wholesale.
 */
test("the built-in profiles apply to adapter-prefixed tool names", () => {
	for (const [tool, server] of [
		["slack_slack_read_channel", "slack"],
		["slack_slack_read_thread", "slack"],
		["slack_slack_search_public", "slack"],
		["slack_slack_search_channels", "slack"],
		["slack_slack_search_users", "slack"],
		["slack_slack_read_user_profile", "slack"],
		["slack_slack_get_reactions", "slack"],
		["datadog_search_datadog_logs", "datadog"],
		["datadog_search_datadog_metrics", "datadog"],
		["datadog_analyze_datadog_logs", "datadog"],
		["linear_list_issues", "linear"],
		["linear_get_issue", "linear"],
		["linear_list_teams", "linear"],
		["metabase_GET_CARD_DATA", "metabase"],
	] as const) {
		assert.equal(allowed(tool, server), true, `${tool} must be allowed`);
		// The server is recoverable from the prefix alone, so an unqualified call
		// gets the same answer.
		assert.equal(allowed(tool), true, `${tool} must be allowed without an explicit server`);
	}
});

test("prefixing does not launder a write into a read", () => {
	for (const [tool, server] of [
		["slack_slack_send_message", "slack"],
		["slack_slack_send_message_draft", "slack"],
		["slack_slack_add_reaction", "slack"],
		["slack_slack_create_canvas", "slack"],
		["mcp__slack_slack_send_message", "slack"],
		["linear_save_comment", "linear"],
		["datadog_update_datadog_monitor", "datadog"],
		["metabase_EXECUTE_SQL_QUERY", "metabase"],
		// Unclassified Slack tool, prefixed: still fails closed.
		["slack_slack_invent_something", "slack"],
	] as const) {
		assert.equal(allowed(tool, server), false, `${tool} must be refused`);
		assert.equal(allowed(tool), false, `${tool} must be refused without an explicit server`);
	}
});

test("variants peel known server prefixes and stop there", () => {
	assert.deepEqual(mcpToolNameVariants("slack_slack_read_channel", ["slack"]), [
		"slack_slack_read_channel",
		"slack_read_channel",
		"read_channel",
	]);
	// An unknown server prefix is not peeled: nothing says what it means.
	assert.deepEqual(mcpToolNameVariants("acme_send_message", ["slack"]), ["acme_send_message"]);
});

/**
 * 2026-09-01 #4: the night contract expects a ticket to be filed for anything
 * surfaced overnight, and forbids touching an existing one. Linear spells both
 * as `save_issue`, so the name cannot decide it and the payload has to.
 */
const createOnlyGate = () => McpReadOnlyGate.of(normalizeMcpReadOnlyConfig({ readOnly: true }));

test("create-only allows filing a new issue", () => {
	const decision = createOnlyGate().decide("save_issue", "linear", {
		title: "HS: track-email defer loop",
		team: "HS",
	});
	assert.equal(decision.allowed, true);
	assert.equal(decision.rule, "create-only");
	assert.match(decision.reason, /no identifier/);
});

test("create-only refuses editing an existing issue, naming the key that gave it away", () => {
	const decision = createOnlyGate().decide("save_issue", "linear", { id: "HS-829", title: "renamed" });
	assert.equal(decision.allowed, false);
	assert.equal(decision.rule, "create-only");
	assert.match(decision.reason, /carries 'id'/);
});

test("create-only treats a blank identifier as absent, the way a client spells 'new'", () => {
	assert.equal(createOnlyGate().decide("save_issue", "linear", { id: "", title: "x" }).allowed, true);
	assert.equal(createOnlyGate().decide("save_issue", "linear", { id: null, title: "x" }).allowed, true);
});

test("create-only leaves every other write refused, payload or not", () => {
	assert.equal(createOnlyGate().decide("slack_post_message", "slack", { channel: "C1", text: "hi" }).allowed, false);
	assert.equal(createOnlyGate().decide("delete_issue", "linear", { title: "x" }).allowed, false);
});

test("create-only gates the gateway path on the forwarded payload", () => {
	assert.throws(
		() =>
			assertMcpGatewayArguments(createOnlyGate(), { tool: "save_issue", server: "linear", args: { id: "HS-829" } }),
		/is refused/,
	);
	assertMcpGatewayArguments(createOnlyGate(), { tool: "save_issue", server: "linear", args: { title: "new" } });
});

test("create-only can be configured for another server", () => {
	const configured = McpReadOnlyGate.of(
		normalizeMcpReadOnlyConfig({ readOnly: true, servers: { notion: { createOnly: ["save_page"] } } }),
	);
	assert.equal(configured.decide("save_page", "notion", { title: "x" }).allowed, true);
	assert.equal(configured.decide("save_page", "notion", { id: "abc" }).allowed, false);
});

test("create-only survives the adapter's prefixing", () => {
	// `linear_save_issue` is the name the adapter actually publishes, so the rule
	// has to match through the prefix or it would fall through to the write shape.
	assert.equal(createOnlyGate().decide("linear_save_issue", "linear", { title: "new" }).allowed, true);
	assert.equal(createOnlyGate().decide("linear_save_issue", "linear", { id: "HS-829" }).allowed, false);
	assert.equal(createOnlyGate().decide("linear_save_issue").server, "linear");
});
