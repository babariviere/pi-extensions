# `mcp` reference — bridge to pi-mcp-adapter

Spindle does not embed an MCP client. `mcp.*` forwards every call to the single `mcp` gateway tool registered by the sibling **`pi-mcp-adapter`** extension. Consequences:

- `~/.pi/agent/mcp.json`, stored OAuth/keyring credentials, and per-server / per-tool disable rules apply unchanged — spindle has no MCP config of its own.
- **Nothing is pre-fetched.** `pi-mcp-adapter` connects servers lazily, so spindle never enumerates tools at sandbox setup. Listing every server's tools eagerly would force every server to connect and could trigger interactive OAuth flows. Discovery is therefore explicit: you call `mcp.list()` / `mcp.search()` / `mcp.describe()` when you actually need it.
- If `pi-mcp-adapter` is not loaded, the `mcp` namespace still exists (so a program type-checks), and the first call throws an actionable error inside the sandbox. Spindle never fails to start because MCP is unavailable.

## Call a tool

```ts
const result = await mcp.call("context7", "resolve_library_id", { libraryName: "react" });
```

Sugar — `mcp.<server>.<tool>(args)` is exactly `mcp.call(server, tool, args)`:

```ts
return await mcp.context7.resolve_library_id({ libraryName: "react" });
```

The object form is available for names computed at runtime, and `server` may be omitted when the tool name is already unambiguous to the adapter:

```ts
return await mcp.call({ server: "my-server", tool: "weird-tool-name", args: { q: "x" } });
```

## Discovery

| Call | Gateway parameters | Purpose |
|------|--------------------|---------|
| `mcp.list()` | `{}` | Server status view from the adapter (does not force a connect) |
| `mcp.list({ server })` | `{ server }` | Status for one server |
| `mcp.search(query)` or `mcp.search({ query, server?, regex?, includeSchemas? })` | `{ search, server?, regex?, includeSchemas? }` | Find tools by query |
| `mcp.describe(tool)` or `mcp.describe({ tool })` | `{ describe }` | One tool's description and input schema |
| `mcp.call(server, tool, args)` | `{ server, tool, args }` | Invoke a tool |

## Result shape

Tool results are normalized to `{ text: string, content: unknown[], structuredContent: unknown }`. A gateway error becomes a thrown exception inside the sandbox, carrying the gateway's text.

## Not available

There is no `mcp.servers()`, `mcp.reload()`, or `mcp.register()`. Those were upstream server-management operations; server registration and reconnection are owned by `pi-mcp-adapter` and its own UI.
