import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
	DEFAULT_MCP_REDIRECT_PORT,
	isToolAllowed,
	loadMcpServerConfig,
	matchesToolSelector,
	mcpConfigLayerPaths,
	mcpRedirectUrl,
	type McpServerDefinition,
	prefixedToolName,
	usesOAuth,
} from "./server-config.ts";

const withAgentDir = <T>(agentDir: string, run: () => T): T => {
	const previous = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous;
	}
};

const loader = (files: Record<string, unknown>) => (filePath: string) => {
	if (!(filePath in files)) throw new Error("ENOENT");
	const value = files[filePath];
	return typeof value === "string" ? value : JSON.stringify(value);
};

const definition = (overrides: Partial<McpServerDefinition> = {}): McpServerDefinition => ({
	name: "slack",
	transport: "http",
	url: "https://mcp.slack.com/mcp",
	disabled: false,
	sources: [],
	...overrides,
});

test("the agent layer is read from PI_AGENT_DIR", () => {
	const agentLayer = path.join("/agent", "mcp.json");
	const config = withAgentDir("/agent", () =>
		loadMcpServerConfig("/repo", {
			readFile: loader({
				[agentLayer]: {
					mcpServers: { slack: { url: "https://mcp.slack.com/mcp", auth: "oauth", excludeTools: ["send_*"] } },
				},
			}),
		}),
	);
	assert.equal(config.errors.length, 0);
	assert.equal(config.servers.length, 1);
	const slack = config.servers[0];
	assert.equal(slack?.transport, "http");
	assert.equal(slack?.auth, "oauth");
	assert.deepEqual(slack?.excludeTools, ["send_*"]);
	assert.deepEqual(slack?.sources, [agentLayer]);
});

test("a project layer overrides the agent layer field by field", () => {
	const agentLayer = path.join("/agent", "mcp.json");
	const projectLayer = path.join("/repo", ".pi", "mcp.json");
	const config = withAgentDir("/agent", () =>
		loadMcpServerConfig("/repo", {
			readFile: loader({
				[agentLayer]: { mcpServers: { linear: { url: "https://mcp.linear.app/mcp", excludeTools: ["a"] } } },
				[projectLayer]: { mcpServers: { linear: { excludeTools: ["b"] } } },
			}),
		}),
	);
	const linear = config.servers[0];
	assert.equal(linear?.url, "https://mcp.linear.app/mcp");
	assert.deepEqual(linear?.excludeTools, ["b"]);
	assert.deepEqual(linear?.sources, [agentLayer, projectLayer]);
});

test("a layer that repoints url drops inherited credentials", () => {
	const agentLayer = path.join("/agent", "mcp.json");
	const projectLayer = path.join("/repo", ".pi", "mcp.json");
	const config = withAgentDir("/agent", () =>
		loadMcpServerConfig("/repo", {
			readFile: loader({
				[agentLayer]: {
					mcpServers: {
						metabase: { url: "https://internal/mcp", bearerToken: "secret", headers: { "X-Key": "k" } },
					},
				},
				[projectLayer]: { mcpServers: { metabase: { url: "https://elsewhere/mcp" } } },
			}),
		}),
	);
	const metabase = config.servers[0];
	assert.equal(metabase?.url, "https://elsewhere/mcp");
	assert.equal(metabase?.bearerToken, undefined);
	assert.equal(metabase?.headers, undefined);
});

test("a socket entry is kept but marked unsupported", () => {
	const agentLayer = path.join("/agent", "mcp.json");
	const config = withAgentDir("/agent", () =>
		loadMcpServerConfig("", {
			readFile: loader({ [agentLayer]: { mcpServers: { mux: { socket: "/tmp/mux.sock" } } } }),
		}),
	);
	assert.equal(config.servers[0]?.transport, "unsupported");
	assert.match(String(config.servers[0]?.unsupported), /socket/);
});

test("a malformed layer is reported without throwing", () => {
	const agentLayer = path.join("/agent", "mcp.json");
	const config = withAgentDir("/agent", () =>
		loadMcpServerConfig("", { readFile: loader({ [agentLayer]: "{ not json" }) }),
	);
	assert.equal(config.servers.length, 0);
	assert.equal(config.errors.length, 1);
});

test("layer order is agent, then .pi/mcp.json, then .mcp.json", () => {
	const layers = withAgentDir("/agent", () => mcpConfigLayerPaths("/repo"));
	assert.deepEqual(layers, [
		path.join("/agent", "mcp.json"),
		path.join("/repo", ".pi", "mcp.json"),
		path.join("/repo", ".mcp.json"),
	]);
});

test("OAuth is auto-detected for a plain http server and opted out by a bearer token", () => {
	assert.equal(usesOAuth(definition()), true);
	assert.equal(usesOAuth(definition({ auth: "oauth" })), true);
	assert.equal(usesOAuth(definition({ bearerToken: "t" })), false);
	assert.equal(usesOAuth(definition({ headers: { Authorization: "Bearer t" } })), false);
	assert.equal(usesOAuth(definition({ oauth: false })), false);
	assert.equal(usesOAuth(definition({ transport: "stdio", url: undefined })), false);
});

test("a selector matches the bare name, the prefixed name, and a glob", () => {
	assert.equal(prefixedToolName("my-server", "read"), "mcp_my_server_read");
	assert.equal(matchesToolSelector("slack", "send_message", ["send_message"]), true);
	assert.equal(matchesToolSelector("slack", "send_message", ["mcp_slack_send_message"]), true);
	assert.equal(matchesToolSelector("slack", "send_message", ["send_*"]), true);
	assert.equal(matchesToolSelector("slack", "read_channel", ["send_*"]), false);
	assert.equal(matchesToolSelector("slack", "read_channel", [""]), false);
});

test("includeTools allowlists and excludeTools subtracts", () => {
	assert.equal(isToolAllowed(definition({ includeTools: ["read_*"] }), "read_channel"), true);
	assert.equal(isToolAllowed(definition({ includeTools: ["read_*"] }), "send_message"), false);
	assert.equal(isToolAllowed(definition({ excludeTools: ["send_*"] }), "send_message"), false);
	assert.equal(isToolAllowed(definition({ includeTools: ["*"], excludeTools: ["send_*"] }), "read_channel"), true);
	assert.equal(isToolAllowed(definition(), "anything"), true);
});

test("the redirect URI falls back to the fixed loopback port", () => {
	const previous = process.env.SPINDLE_MCP_REDIRECT_PORT;
	delete process.env.SPINDLE_MCP_REDIRECT_PORT;
	try {
		assert.equal(mcpRedirectUrl(definition()), `http://127.0.0.1:${DEFAULT_MCP_REDIRECT_PORT}/callback`);
		assert.equal(
			mcpRedirectUrl(definition({ oauth: false })),
			`http://127.0.0.1:${DEFAULT_MCP_REDIRECT_PORT}/callback`,
		);
		process.env.SPINDLE_MCP_REDIRECT_PORT = "4567";
		assert.equal(mcpRedirectUrl(definition()), "http://127.0.0.1:4567/callback");
	} finally {
		if (previous === undefined) delete process.env.SPINDLE_MCP_REDIRECT_PORT;
		else process.env.SPINDLE_MCP_REDIRECT_PORT = previous;
	}
});

test("a configured redirect port wins over the environment", () => {
	const previous = process.env.SPINDLE_MCP_REDIRECT_PORT;
	process.env.SPINDLE_MCP_REDIRECT_PORT = "4567";
	try {
		assert.equal(mcpRedirectUrl(definition({ oauth: { redirectPort: 9999 } })), "http://127.0.0.1:9999/callback");
	} finally {
		if (previous === undefined) delete process.env.SPINDLE_MCP_REDIRECT_PORT;
		else process.env.SPINDLE_MCP_REDIRECT_PORT = previous;
	}
});
