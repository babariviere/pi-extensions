---
name: code-mode
description: Write or debug code_mode TypeScript tool calls in pi.
---

# code_mode

Run tool calls in a type-checked TypeScript program inside an isolated QuickJS sandbox.

## Execution essentials

- Use `pi.*` for core tools. `pi.read`, `pi.find`, `pi.grep`, and `pi.ls` return text; mutating tools return `{ ok, output, details }`. Use `pi.exec({ argv: [program, ...args] })` for literal arguments and `pi.bash` for shell syntax. Both command tools reject on nonzero exit, although `pi.bash` supports `settle: true`.
- Use `web.search({ query, limit? })` to search the web and `web.fetch({ url, timeout? })` to fetch a URL as Markdown when those captured capabilities are available.
- Put multiline content, JSON blobs, long prose, and strings with literal `${...}` in `payloads`, then read them as `π.key`. JSON-encode structured payloads and decode with `JSON.parse(π.key)`.
- Batch independent calls with `Promise.all`; use `mapLimit(items, fn, N)` for bounded concurrency. Keep dependent steps sequential.
- Only the program's `return` enters model context. Return compact results directly, not JSON strings. Keep intermediates local, use `τ` across calls, or files for durable data.

## Repository work

- Locate files with `pi.find`, `pi.grep`, or `pi.ls`, then read relevant ranges with `pi.read({ path, offset, limit })`. Avoid loading large generated, vendored, log, or lock files unless the task needs them.
- Edit with the tools exposed by the session's model-specific profile. The `openai-codex` provider exposes only `pi.applyPatch`; other providers may also expose `pi.edit` and `pi.write`. Never manually edit through Python, shell text utilities, or redirection; formatters, generators, migrations, builds, and tests are allowed. See [file editing](references/full-reference.md#file-editing) for syntax and recovery.

## Read what the call needs

Paths below are relative to this skill directory. Load the relevant reference when its API or failure mode is needed, not the entire set before each call.

| Need | Reference |
|------|-----------|
| Core tool signatures, payloads, runtime limits, state, or argument-shape errors | [Core API](references/full-reference.md) |
| Discover or call an extension tool | [Tool discovery](references/full-reference.md#tools--cross-provider-discovery--generic-dispatch-full-code-mode-only) |
| Find or invoke a lazy MCP service | [MCP](references/mcp.md) |
| Launch, wait for, or cancel subagents; optionally override a model for a specialized run | [Subagents](references/agents.md) |

`tools.search({ query: "web search" })` discovers registered actions, not repository content or lazy MCP tools. Search files with `pi.find` or `pi.grep`; discover MCP services through `mcp.*`. If a call fails, use the error and the relevant signature to correct it rather than retrying guessed arguments.
