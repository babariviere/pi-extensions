---
name: spindle-exec
description: >-
  Execute type-checked TypeScript through spindle_exec. Load before the first
  spindle_exec call or after an argument-shape error.
---

# spindle_exec

Run one TypeScript program for related work. Only its `return` enters model context. Keep large reads, command output, and intermediate data inside the sandbox. Return paths, counts, decisions, and short excerpts instead of raw data. Return structured values directly, for example `return { paths, count }`, rather than `return JSON.stringify({ paths, count })`. Use `JSON.stringify` only when the required result is explicitly a raw JSON string.

## Retrieval first

Search before reading repository files:

- `pi.find` locates files.
- `pi.grep` locates symbols or text. Use small `context` and `limit`.
- `pi.ls` inspects directory structure.
- `pi.read({ path, offset, limit })` reads an identified, bounded range.

Do not whole-file-read logs, generated files, lockfiles, vendored code, or large files unless necessary. `tools.search()` discovers registered actions. It does not search repository contents or lazy MCP servers.

## Core tools

Use `pi.*` inside `spindle_exec`:

| Tool | Result |
|---|---|
| `pi.read`, `pi.grep`, `pi.find`, `pi.ls` | text string |
| `pi.bash`, `pi.edit`, `pi.write` | `{ ok, output, details }` |

Examples:

```ts
const hits = await pi.grep({ pattern: "TargetSymbol", path: "src", context: 2, limit: 30 });
const source = await pi.read({ path: "src/example.ts", offset: 1, limit: 160 });
const { output } = await pi.bash({ command: "rg -n TargetSymbol src" });
```

`pi.bash` rejects on nonzero exit. Pass `settle: true` to inspect `{ ok: false, exitCode, output, error }`. It accepts absolute `cwd`, merged `env`, and `stdin`.

## Payloads and state

Use `payloads` and `π.key` for multiline content, JSON, long prose, and literal `${...}`. Do not inline them in code. Use `τ` only for a large intermediate needed by a later program in this session. Use a file for durable or very large data.

```ts
const request = JSON.parse(π.request);
await pi.write({ path: "/tmp/result.json", content: π.body });
await τ.set("index", request);
```

## Discovery and agents

- If a task names an external service or needs web research, discover tools before declaring the capability unavailable. `tools.search({ query: "web search" })` finds registered tools, including web search.
- Use `mcp.list()` or `mcp.search({ query })` for lazy MCP services. Connect the selected server if needed, then search and describe its action before `mcp.call(server, tool, args)`.
- `agents.run`, `agents.runAll`, `agents.start`, and `agents.wait` run subagents. A `running` result is not a failure.

## Execution

Batch independent work with `Promise.all`. For wide fan-out, use `mapLimit(items, fn, concurrency)`. Put document-sized writes into payloads and write in chunks. For detailed API behavior, load only the needed reference:

- MCP: `skills/spindle-exec/references/mcp.md`
- Subagents: `skills/spindle-exec/references/agents.md`
- Full API and runtime reference: `skills/spindle-exec/references/full-reference.md`

Read the error and correct its shape. Do not guess tool signatures.
