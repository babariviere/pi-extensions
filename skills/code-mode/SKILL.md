---
name: code-mode
description: Write or debug native pi codemode JavaScript scripts and call MCP or extension tools.
---

# Native codemode

Pi 0.99+ owns the `codemode` tool, its QuickJS runtime, tool discovery and MCP. This package does not provide a competing execution tool.

## Execution essentials

- Write raw JavaScript, with top-level `await` and `return`. Do not write TypeScript annotations, markdown fences, or a JSON-encoded source string inside the script.
- Call tools through `tools.<name>({ ... })`. Core tools use their native names, such as `tools.read` and `tools.bash`. Extension tools include `tools.todo_list`, `tools.agents_run`, `tools.jobs_start`, `tools.applyPatch`, `tools.web_search`, and `tools.fetch_content` when loaded.
- Check `ALL_TOOLS`, `await searchTools(query)`, or `await describeTool(name)` for available tools and exact signatures. These discover tools, not repository files. Inactive direct tools are not callable; codemode/deferred tools are callable while registered.
- Batch independent calls with `Promise.all` or `Promise.allSettled`; sequence dependent operations. For wider fan-out, implement a small bounded worker loop instead of starting every promise at once.
- Return compact data. `return`, `text()` and `console.*` all reach the model, so avoid logging large intermediate results. Native output limits can spill full output to a temporary file.
- Use `store(key, value)` and `load(key)` for JSON state across calls. Successful script writes persist on the session branch, including resume. A failed script does not save state, but already completed tool side effects are not undone.
- There are no legacy `pi`, `web`, `mcp`, `agents`, `jobs`, `π`, `τ`, `mapLimit`, `process`, filesystem, network or timer globals. Use registered tools for all host work.

## Repository work

- Prefer `tools.find` for file discovery and `tools.grep` for contents, when enabled. `pattern` in find is a glob; grep patterns are regexes unless `literal: true`. Use `tools.read({ path, offset, limit })` for targeted reads.
- Native read results retain pi's ordinary truncation limits. Read large files in slices rather than assuming scripts receive the entire file.
- Use `tools.edit({ path, edits: [{ oldText, newText }] })`, `tools.write({ path, content })`, or the separate `tools.applyPatch({ patch })` V4A tool. Follow session guidance for the preferred editing route. If an exact edit misses, reread and correct the match.
- Never manually edit through Python, shell text utilities, or redirection; formatters, generators, migrations, builds, and tests are allowed.
- Keep long documents in files where practical. Native codemode accepts only a `code` argument, not legacy payloads. Build strings with ordinary JavaScript quoting; do not accidentally interpolate literal `${...}` content.
- Shell results are structured. Check `exit_code`; a nonzero shell exit is not necessarily a rejected tool promise. Do not hide a failed verification command in a successful script return.

## Read what the call needs

Resolve these paths relative to this skill directory.

| Need | Reference |
| --- | --- |
| Native globals, core tools, file edits, output and errors | [Core API](references/full-reference.md) |
| Discover/configure/call native MCP tools | [MCP](references/mcp.md) |
| Launch, wait for or cancel standalone subagents | [Subagents](references/agents.md) |

For commands that must outlive a script, use `tools.jobs_start({ name, command })`, then `tools.jobs_status`, `tools.jobs_logs`, `tools.jobs_wait`, or `tools.jobs_stop`. Jobs are session-owned, bounded, and unavailable in subagent children. Unclaimed terminal results wake the model; a terminal wait or stop suppresses that notification.
