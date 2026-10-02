# Subagents

Restart-resumable pi-durable conversations and checkpointed background tasks,
with the native Pi tools, extensions, authentication, sandbox, secrets and MCP.
Requires Pi 1.0 and a Node.js 24+ host. Durable execution is the only backend.
There are no Herdr panes, CLI dialect probes or headless Pi launch fallbacks.

## Native tools

| Tool | Purpose |
| --- | --- |
| `agents_list` | Discover markdown definitions. |
| `agents_models` | List permitted model overrides and the generic default. |
| `agents_run` | Start one task and wait for the configured window. |
| `agents_runAll` | Start a parallel batch and wait for the window. |
| `agents_start` | Start a task or batch without waiting. |
| `agents_wait` | Claim results or keep waiting by `runId`. |
| `agents_status` | List live and recent batches without their output. |
| `agents_cancel` | Explicitly abort one batch or every live batch. |

All actions return structured results through native `codemode`. Models, list,
status and cancel are deferred but remain searchable and callable. This extension
does not activate or replace codemode. Read longer workflow guidance with
`describeNamespace("agents")`.

```ts
const run = await tools.agents_start({ task: "Review the test coverage" });
return await tools.agents_wait({ runId: run.runId, waitMs: 1000 });
```

A `running` result is a resumable handle, not a failure. `agents_wait.timeoutMs`
is a compatibility alias for its wait window; `waitMs` wins. The host, not the
caller, sets child lifetime. Terminal results include their stable Harness
`conversationId` when available. The existing task/batch API remains unchanged.

## Configuration and definitions

Read `~/.pi/agent/subagents.json` (or Pi's configured agent directory), then merge
`<cwd>/.pi/subagents.json` only when the parent trusts the project:

```json
{
  "maxPerExecution": 100,
  "timeoutMs": 7200000,
  "waitMs": 600000,
  "defaultModel": "your-provider/your-model-id",
  "defaultThinking": "high"
}
```

- `maxPerExecution` limits launch action calls per enclosing native tool execution,
  including nested codemode calls, not tasks in a batch. Default 100, range 1 to 1000.
- `timeoutMs` is the child's total wall-clock lifetime, including restart downtime.
  Default 2 hours, range 1 second to 24 hours. Recovery does not reset it.
- `waitMs` bounds each default blocking wait. Default 10 minutes, the same
  configuration bounds as lifetime. Per-call `waitMs: 0` detaches immediately.
- Model/thinking defaults are optional. Agent definitions override defaults;
  explicit task overrides override definitions. Generic tasks inherit the live
  parent's physical model when there is no configured default.
- The old `backend` field is ignored. There is no opt-out or fallback backend.
  No executor, MCP or native codemode settings are read from this file.
- Invalid JSON fails explicitly; invalid field values fall back to defaults.

Definitions are discovered recursively under `~/.pi/agent/agents/` and
`<cwd>/.pi/agents/`. Project names override user names. Omit `agent` to use the
generic `task` agent. Frontmatter supports `model`, `thinking`, `sandbox`,
`output`, `defaultReads`, `systemPromptMode`, `inheritSkills` and
`inheritProjectContext`. Final assistant text is the result, not a submission tool.

## Architecture, reload and recovery

Each child runs a genuine `Harness` in an isolated worker. A persistent child
conversation is owned by a background Anchor task. A checkpointed Reporter
submits the task with a stable request ID, waits for its answer, and records an
idempotent passive report. Pi-durable owns model turns, transcripts, tool intents
and task checkpoints. A native SDK session acts only as the tool, prompt and
provider kernel; it does not run a second model loop.

The worker uses Pi's supplied Jiti loader for TypeScript and resolves SDK peers
from the launching Pi host. Managed extension packages do not need their own
SDK installation.

- Requires a file-backed parent session. A second writer for its private journal,
  or for a child Harness, is refused. There is no silent in-memory fallback.
- `/reload` detaches old UI and tool contexts without cancelling admitted work.
  The replacement reconnects to the process-owned supervisor. New launches use
  the new implementation; existing workers keep theirs until restart.
- Quit pauses workers and leaves their conversations/tasks pending. Resume the
  same parent session to reopen the Harness and continue from its checkpoints.
  A process crash also leaves resumable work. Switching to a new session,
  resuming a different session or forking cancels the outgoing parent's live
  batches. Explicit `agents_cancel` aborts, rather than pauses, work.
- Repeated worker admission finds the original child and submission, not a new
  agent. Reporter answer and report receipts commit atomically with their state.
- **Native tools are replay-unsafe**, including codemode and nested calls. A
  crash during a tool produces an interrupted tool result, then the model can
  continue. The tool is not automatically rerun. A tool may already have changed
  files or external systems before its result was committed. Recovery cannot
  guarantee exactly-once external effects.
- Workers disconnect and pause if the parent disappears. Shutdown and timeout
  enforce bounded process-group teardown. A hard crash can still leave tool
  subprocesses alive briefly; inspect external effects before repeating work.
- Unclaimed results trigger a parent follow-up after it becomes idle. Waiting
  for terminal results claims them and suppresses the wake-up. The native parent
  is not a durable Harness conversation: its notification boundary remains
  **at-most-once**, with possible lost wake-ups on crash or delivery failure.
  `agents_status` and `agents_wait` still retrieve the committed result.
- Old lifecycle-only CLI admissions have no conversation checkpoints. Interrupted
  legacy records remain explicit failures; they are never replayed as new tasks.

## Permissions and storage

- The native kernel loads the configured Pi extension/tool stack, including
  builtin codemode, tool search and MCP. Tool calls and nested calls retain native
  argument validation, result transformations, structured output and policy hooks.
- The parent's trust verdict is inherited. Sandboxed definitions retain their
  non-loosenable floor and fail closed if the sandbox extension is unavailable.
  The historical `--code-mode-sandbox` name remains an internal floor marker.
- Children and background attempts cannot recursively launch agents or jobs.
  The `PI_CODE_MODE_SUBAGENT=1` marker remains an internal compatibility contract.
- Model overrides retain provider, enabled-model and price authorization.
  Credentials are resolved at request time by the native provider runtime, never
  stored in recovery inputs. Extension features that start their own model loop
  or replace the native SDK session are not supported by this adapter.
- Approved night tasks require `nightTodoId` and retain isolated jj workspaces,
  their environment and deliverables. Pausing does not delete a pending task's
  workspace. Completion/cancellation releases it and rewrites result paths.
- Parent journal: `<parent-session-file>.subagents-durable/<identity>/`. Child
  Harness: `subagent-runs/<parent-session-id>/<run-id>/<agent>-<index>.durable/`
  beside the parent session. Directories are private (0700), databases 0600.
- **Prompts, policy snapshots, transcripts and tool output are now persisted**, not
  just lifecycle receipts. They may contain sensitive data. Protect these files
  like native Pi sessions. Parent claimed history retains 50 recent batches;
  live/unclaimed records and child Harness files are not automatically erased.
  SQLite WAL protects process restarts, not every power-loss scenario. Pruning
  journal history is not secure deletion.
- A storage failure stops admissions and fails closed. No user settings are
  changed automatically. The optional compact TUI widget is disabled with
  `--no-subagents-progress`; non-interactive operation does not depend on it.
