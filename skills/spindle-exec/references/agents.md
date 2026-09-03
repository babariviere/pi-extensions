# `agents` reference — custom markdown subagents

Spindle's `agents.*` namespace runs **custom agent definitions discovered on disk**, each as a child `pi` session. It is not a general agent runtime: no actors, no recursion, no handoff. What exists is a small run book: launch a batch, wait for it with a bounded window, poll or cancel it by `runId`.

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

Runs one agent and resolves to a single result. Blocks for at most the wait window (`waitMs`, default `agents.waitMs` = 10 min), **not** for the child's whole lifetime.

Two independent deadlines:

| Deadline | Default | What happens when it hits |
|----------|---------|---------------------------|
| `waitMs` | `agents.waitMs` (10 min) | The call returns `{ state: "running", runId, ok: false }`. The child keeps working. Resume with `agents.wait({ runId })`, or let the result arrive on its own (see below). |
| `timeoutMs` | `agents.timeoutMs` (2 h) | The child and its whole process group are killed and the run settles as failed, with whatever output it had produced. |

`request` fields:

| Field | Required | Meaning |
|-------|----------|---------|
| `agent` | yes | Name of a discovered agent (see `agents.list()`) |
| `task` | yes | The concrete task for that agent |
| `model` | no | Override the agent's frontmatter model for this run. Must be in the user's `enabledModels` allowlist when one is configured. |
| `thinking` | no | Override the reasoning effort: `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` |
| `output` | no | **String** path (relative to cwd, or absolute) to persist the result at, instead of the auto run-dir file. There is no `output: false`: omit the field for the default path (a literal `"false"`/`"true"` is treated as omitted). |
| `reads` | no | Files the agent should read first for context. Injected as a read-first instruction; the agent still needs a `read` tool. |
| `waitMs` | no | How long to block before handing back a `running` handle. `0` returns as soon as the run is launched. Batch-level: on `runAll` it goes next to `tasks`, not inside an item. |
| `timeoutMs` | no | Hard cap on the children's own lifetime, clamped to the configured cap. Batch-level, same as `waitMs`. |

Resolves to `SpindleAgentResult`:

```ts
{
  agent: string;       // agent name
  ok: boolean;         // produced usable output AND finished cleanly
  output: string;      // the agent's final assistant message, else backend fallback
  outputPath?: string; // where the result was persisted; absent when nothing landed on disk (see `error`)
  exitCode?: number;   // headless backend only
  paneId?: string;     // herdr backend only
  error?: string;
  state?: "done" | "failed" | "running";  // "running" = wait window expired, child still working
  runId?: string;      // handle for agents.wait / agents.cancel
}
```

Check `state` before treating `ok: false` as a failure: a pending run reports `ok: false` with `state: "running"`.

```ts
const result = await agents.run({
  agent: "reviewer",
  task: "Review the current diff for concrete security defects. Do not edit files.",
  reads: ["package.json"],
});
return { ok: result.ok, output: result.output };
```

## `agents.runAll({ tasks })`

Runs several agents in parallel and waits for all of them, for at most `waitMs`. `tasks` is an array of the same request objects **without** the timing fields: `waitMs` and `timeoutMs` sit next to `tasks` and apply to the whole batch.

```ts
await agents.runAll({ tasks: [{ agent: "reviewer", task: "..." }], waitMs: 60_000 });
```

Resolves to `SpindleAgentResult[]` in input order.

```ts
return await agents.runAll({
  tasks: [
    { agent: "reviewer", task: "Audit the diff for security defects." },
    { agent: "librarian", task: "Summarize how config loading works today." },
  ],
});
```

When several parallel tasks share one `output` path, each run's destination gets a distinct `-<index>` suffix so they do not clobber each other. A single run keeps its `output` verbatim, so stable destinations like `.pi/goal/plan.md` still work.

All runs launched by one call share a single `runId`, and `agents.wait` on it settles when the whole batch settles.

## `agents.start(request | { tasks })`

Launches without blocking and resolves to `{ runId, agents, state: "running" }`. Use it to fan work out and do something else in the same program:

```ts
const { runId } = await agents.start({ agent: "worker", task: "Implement the plan in .pi/goal/plan.md" });
await pi.bash({ command: "go build ./..." });
const settled = await agents.wait({ runId, waitMs: 300_000 });
return settled.state === "running" ? { pending: runId } : settled.results;
```

A `start` run is deliberately **not** tied to the turn that launched it: cancelling that turn does not kill it. It ends when it finishes, when `agents.cancel` is called, or when the session shuts down.

## `agents.wait({ runId, waitMs? })`

`timeoutMs` is also accepted here as an alias for `waitMs`: `run`/`start`/`runAll` use
`timeoutMs` for the child's own lifetime cap, so it is an easy name to reach for
by habit. On `wait` it means the same thing as `waitMs` instead (this call's own
wait window); `waitMs` wins if both are set.

Resumes waiting on a launched batch. Resolves to:

```ts
{
  runId: string;
  state: "running" | "settled" | "cancelled";
  elapsedMs: number;
  agents: string[];
  results: SpindleAgentResult[];  // placeholders while state is "running"
}
```

An expired window is a normal outcome, not an error. Waiting on a batch that already settled returns its results immediately, so a poll loop across several `spindle_exec` calls keeps working, for the 50 most recent batches (older ones are evicted and `agents.wait` then reports an unknown run). A result that was already delivered as a follow-up message can still be returned by a later `wait`.

## `agents.status()`

Lists live and recently finished batches: `{ runId, agents, state, startedAt, elapsedMs, detached }`. `detached: true` means nobody is blocked on it. Outputs are deliberately omitted (50 full subagent results would flood your context): read them with `agents.wait({ runId })`.

## `agents.cancel({ runId? })`

Cancels one batch, or every live batch when `runId` is omitted. Resolves to `{ cancelled: string[] }`. A headless child is torn down process-group wide (SIGTERM, then SIGKILL), so the subprocesses a subagent spawned die with it; a herdr batch has its pane tab closed. The batch reports `state: "cancelled"` immediately, even though the children take a moment to die.

## Unclaimed results arrive as a message

When a batch settles and nobody is waiting on it (its window expired, or it was launched with `agents.start`), the result is injected into the parent session as a follow-up message (`customType: "spindle.agent_result"`) that triggers a turn. You do not have to poll to avoid losing a background run's output; polling is for when you want it *now*.

## Cancellation

- Cancelling the turn (Esc) tears down the children of any batch currently being waited on. That batch is marked cancelled, so its result is not delivered as a message afterwards.
- A detached batch survives the turn; cancel it explicitly with `agents.cancel`, or let session shutdown reap it.
- Session shutdown always cancels every live batch.

## Agent tool allowlists

An agent definition's `tools:` frontmatter restricts what that agent may call. The child `pi` process always keeps `spindle_exec` regardless of the list, because it is the child's only tool path in full code mode. The declared list is enforced one level down instead, inside the child's sandbox: disallowed tools are removed from the declared `pi.*` schema, hidden from listings, and rejected at the `pi.*` / `extensions.*` boundary with an explicit "not in this agent's tool allowlist" error.

`mcp.*`, `agents.*` and `workflow.*` are not covered by `tools:`.

## Execution backend and progress

The backend is chosen by environment, not by the caller: live panes in a dedicated `subagents` tab when running inside herdr, otherwise headless `pi` child processes. Either way each run surfaces as a spinner row in the Spindle widget above the prompt, and as a nested call line in the `spindle_exec` tool result for a run that settles inside the program that launched it. Do not build a busy-wait loop around `agents.status()`: use `agents.wait`, which blocks properly.

## Budget

Each `spindle_exec` invocation is capped at `agents.maxPerExecution` agent calls (100 by default). Pass `agentBudget` on the tool call to lower it for one program. Exceeding the cap throws inside the sandbox.
