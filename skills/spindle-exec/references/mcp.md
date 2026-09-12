# `mcp` reference

Spindle serves `mcp.*` through its own in-process client. It uses `mcp.json` configuration and stored credentials compatible with pi-mcp-adapter; that extension is not required.

## Discovery

| Call | Purpose |
|------|---------|
| `mcp.list()` or `mcp.list({ server })` | Server status from config and cache, without connecting |
| `mcp.search(query)` or `mcp.search({ query, server?, regex?, includeSchemas? })` | Find tools in the schema cache |
| `mcp.describe({ tool, server? })` | Read a cached tool's description and input schema |
| `mcp.connect(server)` | Connect or reconnect one configured server and refresh its schemas |

Discovery does not connect servers automatically. If a configured server has no cached tools, connect that server, then search or describe the needed tool. An empty cache does not mean the service has no tools.

## Call a tool

Use the discovered tool name and input schema:

```ts
return await mcp.call("my-server", "my-tool", { q: "x" });
```

The property form `mcp.<server>.<tool>(args)` calls the same tool. The object form supports computed names; omit `server` only when the tool name is unambiguous:

```ts
return await mcp.call({ server: "my-server", tool: "weird-tool-name", args: { q: "x" } });
```

Tool calls connect lazily and return `{ text: string, content: unknown[], structuredContent: unknown }`. Tool errors reject with their text. Management calls return status, metadata, or connection results instead of this tool-result envelope.

## Authorization and policy

Configured tool filters and Spindle's MCP read-only policy apply to calls. Stored tokens can refresh headlessly. If authorization requires user consent, ask the user to run `/mcp-auth <server>`; the tool cannot open a consent flow on the user's behalf.

Use `/mcp` for status, `/mcp connect <server>` to refresh schemas, and `/mcp logout <server>` to clear stored credentials. There is no `mcp.servers()`, `mcp.reload()`, or `mcp.register()` API.
