# Subagents

Standalone child Pi sessions with bounded waiting, background completion delivery,
process-group cancellation and optional Herdr panes. Requires Pi 1.0 or newer.

## Native tools

| Tool | Purpose |
| --- | --- |
| `agents_list` | Discover markdown definitions. |
| `agents_models` | List permitted model overrides and the generic agent default. |
| `agents_run` | Launch one task and wait for the configured window. |
| `agents_runAll` | Launch a parallel batch and wait for the window. |
| `agents_start` | Launch one task or a batch without blocking. |
| `agents_wait` | Claim results or keep waiting by `runId`. |
| `agents_status` | List live and recent batches without their output. |
| `agents_cancel` | Cancel one batch, or all live batches. |

All actions are callable through `codemode` and return structured results. Common
actions use `codemode` exposure; `agents_models`, `agents_list`, `agents_status`,
and `agents_cancel` are deferred so the inline tool listing stays concise. Deferred
actions remain searchable and callable. Pi configuration controls whether
`codemode` is active; this extension neither enables nor replaces it. Namespace
workflow guidance is available with `describeNamespace("agents")`. A native
script can use:

```ts
const run = await tools.agents_start({ task: "Review the test coverage" });
return await tools.agents_wait({ runId: run.runId, waitMs: 1000 });
```

A `running` result is a handle, not a failed task. Use `tools.agents_wait({ runId })`
to resume waiting, or `tools.agents_cancel({ runId })` to stop it.
`tools.agents_wait.timeoutMs` is a compatibility alias for its wait window;
`waitMs` wins. Per-call child lifetime overrides are not accepted. A detached run
survives its launching turn, but not session replacement, reload or shutdown.
Attached runs are cancelled when their launching call is aborted. Unclaimed
completions trigger one parent follow-up after it becomes idle. A terminal wait
claims the result and suppresses that wake-up.

## Configuration

Read `~/.pi/agent/subagents.json` (or Pi's configured agent directory), then merge
`<cwd>/.pi/subagents.json` only when the parent trusts the project. The former
`code-mode.json` **agents block becomes the root object**:

```json
{
  "maxPerExecution": 100,
  "timeoutMs": 7200000,
  "waitMs": 600000,
  "defaultModel": "anthropic/your-model-id",
  "defaultThinking": "high"
}
```

- `maxPerExecution` limits launch action calls per enclosing native tool execution
  (including nested codemode calls), not the number of tasks in a parallel batch.
  Default 100, clamped to 1 through 1000.
- `timeoutMs` bounds the children's lifetime. Default 2 hours, minimum 1 second,
  maximum 24 hours.
- `waitMs` bounds each default blocking wait. Default 10 minutes, the same
  configuration bounds as `timeoutMs`. A tool call may use `waitMs: 0` to detach.
- Model/thinking defaults are optional. Agent definitions win over these defaults;
  explicit per-task overrides win over agent definitions. Without a configured
  model default, the generic agent inherits the live parent model.
- No executor, MCP or native codemode settings are read here. Invalid JSON fails
  explicitly; invalid field values fall back to defaults.

Definitions are discovered under `~/.pi/agent/agents/` and `<cwd>/.pi/agents/`,
recursively. Project definitions override user definitions by name. Omit `agent`
to use the generic `task` agent. Existing frontmatter supports `model`, `thinking`,
`sandbox`, `output`, `defaultReads`, `systemPromptMode`, `inheritSkills` and
`inheritProjectContext`. Final assistant messages are the result, not a submission
tool. Results are persisted beside the parent session, or under the temporary
`pi-subagents` directory if there is no session file.

## Boundaries and operations

- Child sessions and background attempts never receive agents or jobs tools.
  The existing `PI_CODE_MODE_SUBAGENT=1` environment marker remains a compatibility
  contract between runners and the standalone extensions.
- `--code-mode-task-file` and `--code-mode-sandbox` retain their historical names.
  Subagents registers/delivers the task-file flag even in children. Its small
  injected child extension registers the sandbox flag, while standalone sandbox
  enforces it as a floor. Sandboxed definitions require that extension to be loaded.
- The parent's project-trust verdict is forwarded explicitly, so unattended
  children never stop at a fresh-workspace trust prompt.
- Model overrides stay within the parent provider, `enabledModels` and the
  existing approved price ceiling. `agents_models` omits connection details.
- Approved night tasks require `nightTodoId`; children receive isolated jj
  workspaces, a durable deliverables directory and the night contract. Workspace
  result paths are rewritten before release. Runner launch faults are journaled
  and repeated identical faults trip the existing cause breaker.
- Herdr is optional. Incompatible CLI dialects or repeated launch faults degrade
  to headless child processes. Cancellation closes the Herdr tab or terminates
  the headless process group. Session cleanup drains children for up to 5 seconds.
- A compact progress widget appears only in interactive TUI mode. Disable it with
  `--no-subagents-progress`. Non-interactive and RPC operation does not depend
  on the widget.
