# Code Mode

`code_mode` executes type-checked TypeScript in QuickJS. Read the bundled [skill](../../skills/code-mode/SKILL.md) for tool signatures, payloads, batching, state, and error recovery.

## Configuration and identifiers

- Explicit extension paths use `extensions/code-mode/index.ts`; the model-facing tool and bundled skill are `code_mode` and `code-mode`.
- Controller-owned background attempts load `extensions/code-mode/headless.ts` explicitly instead. This entry requires the attempt marker, isolated profile, untrusted project and print mode. It registers only `code_mode`, uses the same Pi core, MCP, and patch providers, and omits interactive commands, captured extension tools, widgets, web tools, and subagents.
- Configuration is loaded from `~/.pi/agent/code-mode.json` and, for trusted projects, `.pi/code-mode.json`.
- Code Mode environment overrides use the `PI_CODE_MODE_*` prefix.
- Events and persisted protocol values use `pi-code-mode` or `code-mode` prefixes. Child-process flags use `--code-mode-*`.
- No aliases are retained for names from before the rename. Reload Pi after updating manually configured paths or settings.

## Tool exposure and permissions

In full code mode, `code_mode` is the only model-facing tool by default. Pi core tools are called through `pi.*`. The host maps the web extension's `web_search` and `fetch_content` callbacks to `web.search` and `web.fetch`. MCP, subagent, and trusted capability providers are exposed through their explicitly registered typed namespaces. The `tools` global discovers and dispatches registered providers; captured extension tools do not receive a generic provider.

`capture.enabled`, `capture.hideFromModel`, and `capture.keepVisible` control capture and native visibility. Disabling capture removes the web mappings but does not prevent ordinary code execution. Pi core overrides retain their original argument preparation and tool lifecycle hooks. Captured capabilities honor subagent native-tool allowlists and MCP read-only guards.

Trusted hosts may register capability-oriented providers through the existing provider registration event. Registration and tool callbacks are trusted code; namespace naming is not authorization. Mark providers `fullCodeOnly: true` when they must be omitted from orchestration-only declarations, discovery, and dispatch. Pi and web providers are always full-code-only. Helper names and the removed `extensions` namespace cannot be registered.

In orchestration-only mode, native Pi and web tools remain direct tools. `code_mode` retains MCP, subagents, and permitted trusted providers. The filesystem sandbox remains independently configured, and is not implied by the QuickJS guest boundary.

## Shared runtime and installation

The extension imports the shared `@babariviere/code-mode` engine and `/host-pi` adapter from a full Git commit pin. QuickJS execution, TypeScript checking, polyfills, and source maps are implemented in that package, not copied into this extension. Pi-specific tool hooks, live provider dispatch, UI, budgets, cancellation, and session state remain integrated here.

Node 24 or newer is required. Git dependency installation needs network access and lifecycle scripts enabled so its `prepare` build can run. `npm ci --ignore-scripts` is not a supported fresh installation. The package remains private and is not published to npm. No neighboring `code-mode` checkout is needed.

## Commands

- `/sandbox` inspects or changes the filesystem sandbox within configured floors.
- `/mcp` shows status, lists tools, connects servers, or logs out.
- `/mcp-auth` performs explicit MCP authorization.

The async `τ` scratchpad survives calls within the session, not session restarts. Payloads, output limits, source-mapped errors, agent call budgets, progress rendering, and the `mapLimit` helper retain their existing contracts.

## Background jobs

In full code mode, `jobs.start({ name, command, cwd? })` starts a shell command without blocking the program. Use `jobs.status()` to see running and recent jobs, `jobs.logs({ id, maxChars? })` for a bounded output tail, `jobs.wait({ id, waitMs? })` to wait up to 120 seconds (default 30 seconds), and `jobs.stop({ id })` to terminate the process group. `jobs.wait` returns `state: "running"` while the process is still alive. The job has a two-hour lifetime limit and at most 20 jobs can run concurrently. The shell command uses the same OS sandbox wrapper as `pi.bash`; without an enforcing sandbox it runs with the user's permissions.

In TUI mode, running jobs appear in the Code Mode widget above the editor with their name, short id, and elapsed time. They disappear from the running list when they exit or are stopped. An executing `code_mode` program shows its active nested calls and their progress; between calls it shows `Running TypeScript` and the most recent call. The widget obeys the existing `ui.enabled`, `ui.widget`, and `ui.maxRows` settings; `jobs.status()` remains available for a complete history.

An exited job whose result was not claimed by a terminal `jobs.wait` sends a follow-up message that wakes the model. If the agent is working when it exits, delivery waits until the turn settles, so a terminal `jobs.wait` in that turn can claim it without a redundant wake-up. An active job never sends a completion message; a stopped job does not wake the model. Output is capped at 8 MB per job, with truncation indicated in status and logs. A job is owned by this session and is stopped on session shutdown or reload. Its temporary output file is removed then, so copy needed results before leaving the session. This is not a durable job queue or a way to keep watchers running across restarts. Jobs are unavailable in subagent child sessions (including herdr panes): Pi can mark a child's turn done before a detached job exits, misleading the parent about the child's status.

`agents.start` and timed-out `agents.run` / `agents.wait` likewise retain `running` status while their children are alive. `agents.wait` claims a terminal result so its completion is not also injected as a follow-up; `agents.cancel` suppresses the notification for a cancelled batch. Unclaimed subagent completions also wait for the parent turn to settle before waking it. The `agents.*` namespace is unavailable in child sessions for the same reason as jobs: a child Pi turn can settle while its own detached subagent is still running, falsely marking the parent-visible child as done.

`pi.read` hands the complete requested text to the program, including files past Pi's model-facing read limit. It is not subject to the nested result cap. The QuickJS heap still limits how much a program can hold; use `offset` and `limit` for files too large for memory. Model-facing returns are bounded by `executor.maxOutputChars`, and oversized output spills to a temporary file whose path is included in the result. Read that file in smaller slices in subsequent calls. `τ` is optional explicit cross-call state and has its own 4 MB per-value limit, so oversized returns are not automatically stored there.
