# Standalone subagents

The `subagents` extension supplies native tools named `agents_*`. Scripts call them through `tools`, not an `agents` global. These tools run custom markdown definitions as child pi sessions; omit `agent` for the generic task agent.

For routine delegation, omit `model` and `thinking`. Named-agent frontmatter takes precedence over configured defaults; missing defaults fall back to the parent. Only use overrides for unusually demanding work. Discover valid names with `tools.agents_list({})` and model IDs with `tools.agents_models({})` when an override is needed.

| Tool | Input | Purpose |
| --- | --- | --- |
| `agents_list` | `{}` | Discover user/project agents |
| `agents_models` | `{}` | Permitted model overrides and default |
| `agents_run` | `{ task, agent?, model?, thinking?, output?, reads?, waitMs?, night?, nightTodoId? }` | Run one task with a bounded wait |
| `agents_runAll` | `{ tasks: [...], waitMs? }` | Run a batch in parallel |
| `agents_start` | Single task or `{ tasks: [...] }` | Detach and return a run handle |
| `agents_wait` | `{ runId, waitMs? }` | Resume a bounded wait |
| `agents_status` | `{}` | Live and recent batch metadata |
| `agents_cancel` | `{ runId? }` | Stop one batch or all live batches |

Inspect `describeTool()` for the loaded tool's exact schema. A result with `state: "running"` and `ok: false` is pending work, not failure. Wait windows and child lifetime limits are distinct. Detached children survive the launching script, but not session shutdown. Cancelling an attached wait cancels its children; cancelled batches suppress completion notifications.

Unclaimed completions arrive as follow-up messages after the parent settles. A terminal `agents_wait` claims the result so it is not announced again. Children do not expose subagent or background-job tools, avoiding misleading parent-visible completion while nested work remains alive.

Delegate only bounded independent work. Start with one agent, or a few truly independent tasks. Give each a concrete deliverable and nonoverlapping file ownership. Pass the task artifact directory and resolved output paths. For large inputs, provide files or a manifest instead of embedding all data in the task. Never share one output file between concurrent tasks.

Definitions are discovered under the agent directory's `agents/` and trusted project `.pi/agents/`. Subagent configuration is `subagents.json`, not the removed `code-mode.json`. Sandboxed definitions retain a floor the child cannot loosen.

```js
const run = await tools.agents_start({ task: "Review the changed files. Do not edit.", output: ".pi/goal/my-task/review.md" });
return await tools.agents_wait({ runId: run.runId, waitMs: 30000 });
```
