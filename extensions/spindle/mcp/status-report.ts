/**
 * Text for the `/mcp` command.
 *
 * Kept out of `index.ts` and free of side effects so the formatting is testable
 * and the command handler stays a thin shell.
 */

import type { McpServerStatus, McpToolSummary } from "./client-hub.ts";

const STATE_LABEL: Record<McpServerStatus["state"], string> = {
	connected: "connected",
	idle: "idle",
	"needs-auth": "needs auth",
	failed: "failed",
	disabled: "disabled",
	unsupported: "unsupported",
};

const pad = (value: string, width: number): string => value.padEnd(width, " ");

export const formatMcpStatus = (servers: McpServerStatus[], errors: string[] = []): string => {
	if (servers.length === 0) {
		return "No MCP server is configured. Add one to ~/.pi/agent/mcp.json (or .pi/mcp.json in a project).";
	}
	const nameWidth = Math.max(...servers.map((server) => server.name.length), 6);
	const stateWidth = Math.max(...servers.map((server) => STATE_LABEL[server.state].length), 5);
	const lines = servers.map((server) => {
		// "cached" is worth showing: it is why discovery answered without a connect.
		const tools =
			server.tools === undefined
				? ""
				: `${server.tools} tool${server.tools === 1 ? "" : "s"}${server.cached ? " (cached)" : ""}`;
		const detail = server.detail ? ` — ${server.detail}` : "";
		return `${pad(server.name, nameWidth)}  ${pad(STATE_LABEL[server.state], stateWidth)}  ${pad(tools, 16)}${server.target ?? ""}${detail}`.trimEnd();
	});
	const needsAuth = servers.filter((server) => server.state === "needs-auth").map((server) => server.name);
	const footer = [
		"",
		needsAuth.length > 0
			? `Authorize with: ${needsAuth.map((name) => `/mcp-auth ${name}`).join(" | ")}`
			: "Authorize a server with /mcp-auth <server>; refresh its tools with /mcp connect <server>.",
	];
	const problems = errors.length > 0 ? ["", "Config problems:", ...errors.map((error) => `  ${error}`)] : [];
	return ["spindle MCP client", "", ...lines, ...problems, ...footer].join("\n");
};

export const formatMcpTools = (tools: McpToolSummary[], server?: string): string => {
	if (tools.length === 0) {
		return server
			? `No tools cached for '${server}'. Run /mcp connect ${server} to list them.`
			: "No MCP tools are cached yet. Run /mcp connect <server> to list a server's tools.";
	}
	const byServer = new Map<string, McpToolSummary[]>();
	for (const tool of tools) {
		byServer.set(tool.server, [...(byServer.get(tool.server) ?? []), tool]);
	}
	const sections = [...byServer.entries()].map(([name, entries]) => {
		const listed = entries.map(
			(tool) => `  ${tool.name}${tool.description ? ` — ${tool.description.split("\n")[0]}` : ""}`,
		);
		return [`${name} (${entries.length})`, ...listed].join("\n");
	});
	return sections.join("\n\n");
};
