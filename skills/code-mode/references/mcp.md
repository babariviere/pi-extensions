# Native MCP

Pi 0.99+ owns MCP connections, OAuth, discovery, resources and tool calls. This package does not provide an MCP client or override `/mcp`.

## Call tools

MCP tools are named `mcp__<server>__<tool>`. Discover them with `await searchTools(query, { namespace: "mcp__server" })` or `ALL_TOOLS`, and read exact declarations with `describeTool(name)`. Then call `tools.<name>(args)`.

Scripts receive the full MCP `CallToolResult`: `content`, optional `structuredContent`, and `isError`. An MCP error result may resolve instead of rejecting; check `isError`. Forward an individual image block with `image(result.content[0])`. There are no legacy `mcp.list`, `mcp.call`, or `mcp.*` globals.

Resource tools are `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource`, when offered. Use their declared schemas, including the server and URI.

## Configuration

Servers live in `~/.pi/agent/mcp.json` or trusted project `.pi/mcp.json`, under `mcpServers`. Pi supports stdio and streamable HTTP, not legacy SSE. A project server replaces the global entry with the same name. A command is one executable plus an `args` array, not a shell string. `timeout` is in seconds; `enabled: false` disables an entry.

Use `${NAME}` in env/header values or a whole `!command` value for credential lookup. Never embed credentials in repository files, reports or tool output. Native OAuth credentials live in `mcp-auth.json`; previous extension keyring credentials do not automatically transfer.

Exposures: `codemode` (default), `codemode-deferred`, `deferred`, `direct`, `hidden`. `toolExposure` can override individual tools with exact names or wildcard patterns. Hidden tools are unreachable. Large catalogs need not be declared directly: native codemode has an inline budget and lazy discovery.

Manage servers with `/mcp`, or `pi mcp add|remove|list|login|logout`. Configuration changes require `/reload` or a new session. Login opens a browser and needs explicit user authorization; do not start consent flows silently. `/mcp` may change exposure or enabled state and persists those changes.

Tool calls pass through pi's permission and secret-redaction pipeline, including native codemode nested calls. The separate sandbox extension can impose read-only MCP policy for night runs. Tool annotations describe behavior; they are not proof that a remote tool is safe.
