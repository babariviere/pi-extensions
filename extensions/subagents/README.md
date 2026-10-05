# Subagents

Named persistent pi-durable conversations with native Pi tools, extensions,
authentication, trust, sandbox, secrets and MCP. Requires Pi 1.0 and Node.js 24+.
Durable execution is the only backend, with no Herdr panes or headless CLI fallback.

## Single tool

The exact input is `subagent({ action: "spawn" | "send" | "stop" | "status", name?, message?, followUp? })`.
Call it from native codemode as `tools.subagent`; discover its schema with
`describeTool("subagent")`. This extension does not replace or enable codemode.

| Action | Inputs and behavior |
| --- | --- |
| `spawn` | Requires `name` and `message`. Creates a conversation and starts background work. An existing name is rejected; use `send`. |
| `send` | Requires `name` and `message`. Steers current work by default; `followUp: true` queues a follow-up instead. An idle conversation resumes on the same transcript. |
| `stop` | Requires `name`. Aborts current and queued work, but retains the conversation for later `send`. |
| `status` | With `name`, returns state and the latest completed `lastAnswer: { id, text }`, when available, acknowledging that answer's pending notification. Without a name, returns compact summaries without answer text or acknowledgements. |

Names identify conversations within the parent session, **not Markdown personas**.
Names must be nonempty, at most 128 characters, and contain no control characters.
Messages must be nonempty. Calls acknowledge admission, not completion. There are
no batch tools, wait windows, result claims or job handles.

```ts
await tools.subagent({ action: "spawn", name: "coverage", message: "Review test coverage. Do not edit files." });
await tools.subagent({ action: "send", name: "coverage", message: "Focus on crash recovery." });
await tools.subagent({ action: "send", name: "coverage", message: "Then summarize missing tests.", followUp: true });
return await tools.subagent({ action: "status", name: "coverage" });
```

Unread completed answers are delivered automatically to the parent as follow-ups
when it is idle. Named status acknowledges the exact `lastAnswer` it returns, so
that answer will not also produce a pending notification. The answer stays
available for repeated reads, including after notification, stop or failed work.
The all-agent overview acknowledges nothing. Other unread answers and failures
still notify. Notifications already delivered or queued cannot be retracted.
Failed work exposes the provider's textual diagnostic in named status and failure
notifications when available, rather than only a generic reason such as `model_error`.
No automatic Markdown output is written. Describe briefs to read, permissions,
scope and any explicitly requested deliverables in `message`.

## Host configuration

Read `~/.pi/agent/subagents.json` (or Pi's configured agent directory), then merge
`<cwd>/.pi/subagents.json` only when the parent trusts the project:

```json
{
  "maxPerExecution": 100,
  "timeoutMs": 7200000,
  "defaultModel": "your-provider/your-model-id",
  "defaultThinking": "high"
}
```

- `maxPerExecution` limits spawn calls per enclosing native tool execution,
  including nested codemode calls. Default 100, range 1 to 1000.
- `timeoutMs` bounds an active work cycle, not the persistent conversation's age.
  Default 2 hours, range 1 second to 24 hours. Steering and recovery do not reset
  an active deadline; restart downtime counts. New work after idle gets a new cycle.
- The host selects `defaultModel`, otherwise the parent's resolved **physical**
  model, and pins it at spawn for subsequent sends and recovery. `defaultThinking`
  is host policy too. No persona or caller model/thinking overrides exist.
- Selection must pass same-provider, `enabledModels`, catalog and price guards.
  Unavailable/unpriced models or reference prices fail closed. The price ceiling
  is the higher input-plus-output rate of `claude-opus-5-5` and `gpt-6.1-sol`.
- `waitMs` and `backend` are retired. Invalid JSON fails explicitly; invalid
  supported field values fall back to defaults. No user settings change automatically.

## Reload, shutdown and recovery

Each child has an isolated native SDK kernel for tools, prompts and provider
access. Pi-durable alone owns its canonical conversation and model loop, with
background Anchor ownership and checkpointed Reporter tasks. Idle workers may
park without deleting their conversation. SDK peers resolve from the launching
Pi host, including managed packages without a local SDK installation.

- Requires a file-backed parent session. Single-writer ownership is enforced for
  parent and child SQLite storage; storage failures stop admissions, not fall back
  to memory.
- `/reload` detaches old contexts without cancelling admitted work. The new
  extension reconnects to the supervisor; existing workers retain their code
  until restart. Compatible supervisor upgrades pause workers and reopen their
  durable conversations without cancelling pending work. Ordinary parent-turn
  cancellation does not stop background work.
- Quit pauses workers and preserves pending checkpoints. Resume the same parent
  session to recover them. Switching, forking or resuming a different session
  cancels outgoing work. Explicit `stop` aborts work, not the conversation.
- Admissions and cancellation are persisted before execution. Stable input IDs
  prevent retry duplication; completed answers are deduplicated by answer identity.
- **Native tools are replay-unsafe**, including codemode and nested calls. A crash
  during a tool yields an interrupted result, not automatic re-execution. A tool
  may already have changed files or external systems. Exactly-once external effects
  are not guaranteed; inspect them before repeating work.
- Workers pause if the parent disappears. Shutdown and timeouts bound process
  teardown, but a hard crash may briefly leave tool subprocesses alive.
- Native-parent notification is **at-most-once**, not exactly-once. Its durable
  receipt is consumed before delivery, so a crash, reload, failed delivery or
  discarded queued follow-up may lose the notification. Named `status.lastAnswer`
  still exposes the committed answer. Reading it acknowledges its pending
  notification, not the answer itself, and never resends it.

## Permissions and storage

- Native argument validation, structured results, transformations and policy
  hooks apply to direct and nested calls. Parent trust and sandbox floors remain
  enforced; required sandbox enforcement fails closed if unavailable.
- Children and background attempts cannot launch subagents or jobs. The internal
  `PI_CODE_MODE_SUBAGENT` and sandbox markers are not caller options.
- Authentication is resolved by the native provider runtime, not persisted as
  credentials. Extensions that replace the SDK session or start their own model
  loop are unsupported by this adapter.
- Night planning children automatically inherit read-only filesystem/MCP policy.
  Approved execution requires the approved `TODO-<id>` as `name` on both spawn
  and send. Put the approved goal, permissions, outputs and brief paths in
  `message`; these describe scope, not extra sandbox grants. Workspace placement
  and lifecycle are host-controlled. Answer completion, stop, idle parking and
  reload do not release a reusable conversation's workspace. Required isolation
  fails closed on allocation failure. New messages cannot reuse a pre-night,
  ended or replaced approval; a cancelling host lifecycle boundary retires night
  conversations and preserves their deliverables before workspace release.
- Parent journal: `<parent-session-file>.subagents-durable/<identity>/`. Child
  Harness databases live in internal `subagent-runs/` directories beside the
  parent session. These are recovery storage, **not output directories**.
  Directories are private (0700), databases 0600.
- Prompts, policy snapshots, transcripts and tool results may contain sensitive
  data. Protect them like native Pi sessions. No TTL deletes persistent databases
  or parked conversations. SQLite WAL supports process restart, not every
  power-loss scenario; deleting history is not secure deletion.
- Child token usage in durable SQLite is **not automatically included** in native
  parent usage or JSONL-based `pi-usage` scanner totals. Status reads do not bill
  those answers again.
- Disable the optional TUI widget with `--no-subagents-progress`.

## Breaking upgrade

The prior `agents_*` tool API is removed, not aliased. Replace it with
`tools.subagent`; `output`, `reads`, `task`, `model`, `thinking`, `night`,
`nightTodoId`, batch and wait arguments are not accepted. Markdown definitions
are no longer discovered as personas.

Old job handles cannot map to persistent names. Pending old jobs are safely
retired rather than replayed as new conversations; their journals are retained
for inspection. Spawn a new named conversation explicitly after reviewing any
interrupted effects. Updating packages or configuration does not translate old
caller scripts automatically.
