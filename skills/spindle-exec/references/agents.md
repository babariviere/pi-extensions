# `agents` reference — custom markdown subagents

Spindle's `agents.*` namespace runs **custom agent definitions discovered on disk**, each as a child `pi` session. It is not a general agent runtime: there are no handles, no `spawn`/`wait`/`stop`, no actors, no recursion, and no handoff. Exactly three methods exist.

Agent definitions are markdown files with YAML frontmatter, discovered from:

- user scope: `$PI_CODING_AGENT_DIR/agents/**/*.md` (default `~/.pi/agent/agents`)
- project scope: `<cwd>/.pi/agents/**/*.md`

Project scope wins on a name collision. If no definitions exist, `agents.run` throws and names both searched directories.

## `agents.list()`

Takes no arguments. Resolves to `Array<{ name: string; scope: "project" | "user"; description?: string }>`.

```ts
return await agents.list();
```

## `agents.run(request)`

Runs one agent to completion and resolves to a single result. Blocks until the child finishes or the configured `agents.timeoutMs` elapses.

`request` fields:

| Field | Required | Meaning |
|-------|----------|---------|
| `agent` | yes | Name of a discovered agent (see `agents.list()`) |
| `task` | yes | The concrete task for that agent |
| `model` | no | Override the agent's frontmatter model for this run. Must be in the user's `enabledModels` allowlist when one is configured. |
| `thinking` | no | Override the reasoning effort: `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` |
| `output` | no | **String** path (relative to cwd, or absolute) to persist the result at, instead of the auto run-dir file. There is no `output: false`: omit the field for the default path (a literal `"false"`/`"true"` is treated as omitted). |
| `reads` | no | Files the agent should read first for context. Injected as a read-first instruction; the agent still needs a `read` tool. |

Resolves to `SpindleAgentResult`:

```ts
{
  agent: string;       // agent name
  ok: boolean;         // produced usable output AND finished cleanly
  output: string;      // the agent's final assistant message, else backend fallback
  outputPath: string;  // where the result was persisted
  exitCode?: number;   // headless backend only
  paneId?: string;     // herdr backend only
  error?: string;
}
```

```ts
const result = await agents.run({
  agent: "reviewer",
  task: "Review the current diff for concrete security defects. Do not edit files.",
  reads: ["package.json"],
});
return { ok: result.ok, output: result.output };
```

## `agents.runAll({ tasks })`

Runs several agents in parallel and waits for all of them. `tasks` is an array of the same request objects. Resolves to `SpindleAgentResult[]` in input order.

```ts
return await agents.runAll({
  tasks: [
    { agent: "reviewer", task: "Audit the diff for security defects." },
    { agent: "librarian", task: "Summarize how config loading works today." },
  ],
});
```

When several parallel tasks share one `output` path, each run's destination gets a distinct `-<index>` suffix so they do not clobber each other. A single run keeps its `output` verbatim, so stable destinations like `.pi/goal/plan.md` still work.

## Agent tool allowlists

An agent definition's `tools:` frontmatter restricts what that agent may call. The child `pi` process always keeps `spindle_exec` regardless of the list, because it is the child's only tool path in full code mode. The declared list is enforced one level down instead, inside the child's sandbox: disallowed tools are removed from the declared `pi.*` schema, hidden from listings, and rejected at the `pi.*` / `extensions.*` boundary with an explicit "not in this agent's tool allowlist" error.

`mcp.*`, `agents.*` and `workflow.*` are not covered by `tools:`.

## Execution backend and progress

The backend is chosen by environment, not by the caller: live panes in a dedicated `subagents` tab when running inside herdr, otherwise headless `pi` child processes. Either way each run surfaces as a spinner row in the Spindle widget above the prompt and as a nested call line in the `spindle_exec` tool result — do not build your own polling loop.

## Budget

Each `spindle_exec` invocation is capped at `agents.maxPerExecution` agent calls (100 by default). Pass `agentBudget` on the tool call to lower it for one program. Exceeding the cap throws inside the sandbox.
