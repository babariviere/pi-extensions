# spindle — vendored fork of pi-fabric

`spindle` is a trimmed, vendored fork of **pi-fabric**. It exposes exactly one
tool, `spindle_exec` (a code-mode QuickJS sandbox), and exactly one UI surface,
a widget mounted with `placement: "aboveEditor"`.

## Provenance

| | |
|---|---|
| Upstream repo | `https://github.com/monotykamary/pi-fabric` |
| Upstream license | MIT |
| Pinned tag | `v0.28.2` |
| Pinned commit | `2af532f17c6b778b667a61b72c0a5d5d611145ed` |
| Vendored from | `<clone>/src/**` (the published npm package ships only `dist/`, so the fork must come from the git repo) |

The fork was taken from a local clone at `/tmp/pf-probe` checked out at that
tag. Nothing here is generated: every file below was copied and then edited by
hand.

## Sandbox surface

Globals inside `spindle_exec`:

- `pi.*` — Pi core tools (full code mode only), via `providers/pi-tools-provider.ts`
- `extensions.*` — tools registered by sibling extensions, via `capture/` + `providers/captured-tools-provider.ts`
- `tools.*` — cross-provider discovery and generic dispatch (full code mode only): `providers` / `catalog` / `list` / `search` / `describe` / `call` over every registered provider
- `mcp.*` — MCP tools through the `pi-mcp-adapter` `mcp` gateway tool, via `providers/mcp-bridge-provider.ts`
- `agents.*` — custom markdown subagents, via `providers/agents-provider.ts` + `agents/`
- `workflow.{parallel,pipeline,phase,item,event,log,configure}` plus the bare aliases `parallel` / `pipeline` / `phase` / `log`
- `process` — minimal shim built from `env-snapshot.ts`: allowlisted `process.env` (HOME, USER, LOGNAME, SHELL, PWD, PATH, LANG, LC_*, TERM, TMPDIR, XDG_*), `process.platform` / `process.arch`, `process.cwd()`. No secret ever enters the guest.
- `print`, `console`, `π` (named strings), `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`

Deliberately absent: `memory`, `state`, `schema`, `compact`, `mesh`,
`council`, `rlm`, `agent()`, `budget`, `workflow.agent`, `workflow.budget`.

## Vendored file manifest

Upstream path → local path is `src/X` → `extensions/spindle/X` for everything in
this list, **except** the four `fabric`-named files, which were renamed. See the
rename mapping below; it must be applied to every upstream patch.

### Top level
`async-settlement.ts`, `config.ts`, `config-migrations.ts`, `execution-service.ts`,
`spindle-exec-tool.ts`, `spindle-state.ts`, `host-compatibility.ts`, `index.ts`,
`protocol.ts`, `util.ts`

### `runtime/`
`guest-types.ts`, `orchestration.ts`, `quickjs-runtime.ts`, `type-checker.ts`

### `core/`
`action-registry.ts`, `call-preview.ts`, `pi-tools.ts`, `skill-dir.ts`,
`skill-prompt.ts`, `skill-references.ts`, `tool-ownership.ts`, `tool-result-proxy.ts`

### `audit/`, `activity/`, `capture/`
`audit/{index,details,projection,trace}.ts`, `activity/{store,types}.ts`,
`capture/{catalog,interceptor}.ts`

### `providers/`
`pi-tools-provider.ts`, `captured-tools-provider.ts`, `write-preview.ts`

### `ui/`
`spindle-render.ts`, `core-tool-render.ts`, `spindle-code-parser.ts`, `highlight.ts`,
`format.ts`, `preview-lines.ts`, `diff-background.ts`, `row-balance.ts`,
`spinner.ts`, `structured.ts`, `code-preview.ts`, `code-preview-shell.ts`,
`word-diff/` (whole directory), `widget.ts`, `types.ts`, `snapshot.ts`,
`controller.ts`, `transcript.ts`, `transcript-parser.ts`, `transcript-sanitization.ts`

## Rename mapping — upstream → local

The fork is fully self-named: **no `fabric` token survives anywhere in local
code or in local file names.** Every upstream patch must be translated through
this table before it applies.

### Paths

| Upstream | Local |
|---|---|
| `src/fabric-exec-tool.ts` | `extensions/spindle/spindle-exec-tool.ts` |
| `src/fabric-state.ts` | `extensions/spindle/spindle-state.ts` |
| `src/ui/fabric-render.ts` | `extensions/spindle/ui/spindle-render.ts` |
| `src/ui/fabric-code-parser.ts` | `extensions/spindle/ui/spindle-code-parser.ts` |
| anything else | `src/X` → `extensions/spindle/X` |

### Identifiers and strings

| Upstream | Local |
|---|---|
| `Fabric*` (types, classes, interfaces) | `Spindle*` |
| `FABRIC_*` (constants, env vars) | `SPINDLE_*` |
| `fabric*` (variables, functions, fields, comments) | `spindle*` |
| `fabric.$*` (host-call names) | `spindle.$*` |
| `__fabric*` / `__pi_fabric_*` (guest globals) | `__spindle*` / `__pi_spindle_*` |
| `fabric_exec` (tool name) | `spindle_exec` |
| `"pi-fabric…"` event / symbol / kind literals | `"pi-spindle…"` |
| `"pi-fabric"` widget id | `"spindle"` |
| `fabric.json` config file | `spindle.json` |

The `fabric.$*` → `spindle.$*` row spans a host/guest boundary that no
type-checker covers: the guest half lives inside the `GUEST_SETUP`
string literal in `runtime/quickjs-runtime.ts`, the host half in the host-call
`switch` in `execution-service.ts`. They must be renamed together; a mismatch
fails only at runtime, silently. Two guards exist: after any port,
`rg 'fabric\.\$' extensions/spindle` must be empty, and
`runtime/guest-host-refs.test.ts` executes every guest API against a recording
host bridge and asserts each emitted ref is handled (an explicit case, a
runtime-internal handler such as `spindle.$timer`, or a registry provider
namespace) and that every static `spindle.$*` case is reachable.

## Render parity set

These files carry **no hand edits**. They differ from upstream `v0.28.2` by
exactly two mechanical rewrites, and nothing else:

1. the `.js` → `.ts` relative-import-specifier rewrite described below, and
2. the `fabric` → `spindle` rename from the mapping table above (which also
   renamed two of the files themselves).

So they are **not byte-identical to upstream** — do not assume a clean `diff`.
Still, do not edit them by hand: port upstream changes verbatim and re-apply
both rewrites.

`ui/spindle-render.ts`, `ui/core-tool-render.ts`, `ui/code-preview.ts`,
`ui/code-preview-shell.ts`, `ui/highlight.ts`, `ui/format.ts`,
`ui/preview-lines.ts`, `ui/spindle-code-parser.ts`, `ui/diff-background.ts`,
`ui/row-balance.ts`, `ui/spinner.ts`, `ui/structured.ts`, `ui/word-diff/*`,
`ui/widget.ts`, `ui/transcript-sanitization.ts`

Also currently carrying no hand edits (same two mechanical rewrites only; not
part of the guaranteed parity contract, but useful to know):
`activity/{store,types}.ts`, `audit/index.ts`,
`core/{call-preview,pi-tools,skill-dir,tool-result-proxy}.ts`,
`providers/write-preview.ts`, `async-settlement.ts`,
`config-migrations.ts`, `host-compatibility.ts`, `util.ts`.

`runtime/type-checker.ts` **does carry hand edits**: `sourceMap: true` on the
emit (consumed by `runtime/source-map.ts`), `transpileSpindleCode` returning
`{ javascript, sourceMap }` instead of a bare string, and delegation of both
entry points through the `runtime/checker-backend.ts` seam (the stock
`typescript` backend registers itself as the default).

Because `ui/widget.ts` is in the parity set, the rewritten `ui/types.ts` must stay
a strict structural superset of what it reads. That is why
`SpindleDashboardSnapshot` still carries `widgetDismissedAt` and an `actors`
field with a minimal local `SpindleUiActor`: spindle has no actor subsystem and
always populates `actors: []`, but the field must exist so the parity renderer
compiles untouched.

## Global `.js` → `.ts` specifier rewrite

Every **relative** import specifier in the vendored tree was rewritten from
`./x.js` to `./x.ts`. The rest of this repo's `extensions/` uses `.ts`
specifiers under `allowImportingTsExtensions`, and that is the resolution proven
to work under Pi's loader here; `.js` → `.ts` resolution at runtime is
unverified. Bare package specifiers are untouched.

After porting any upstream diff, re-run the rewrite on the touched files:

```sh
fd -e ts . extensions/spindle -x perl -pi -e 's{(from\s+")(\.\.?/[^"]*)\.js(")}{$1$2.ts$3}g'
```

## Trim manifest — dropped upstream subsystems

| Dropped | Reason |
|---|---|
| `src/actors/`, `src/mesh/`, `src/topology/`, `src/lifecycle/` | Actor/mesh/participant runtime; out of scope |
| `src/agents/` (upstream's own RLM/handoff/transport agent runtime) | Replaced by the absorbed subagents code in local `agents/` (see the name-collision note below) |
| `src/memory/`, `src/state/`, `src/schema/`, `src/compaction/` | Memory index, mesh state layer, schema enforcement, deterministic compaction; out of scope |
| `src/prewalk/` | Handoff-at-boundary prewalk; out of scope |
| `src/commands/` | Upstream's slash command and its dashboard entry point |
| `src/storage/`, `src/worker/`, `src/worker.ts`, `src/main-agent.ts`, `src/log-tail.ts` | Only reachable from dropped subsystems |
| `src/providers/mcp-provider.ts` | Upstream's own embeddable MCP client (the `createRuntime` package listed in upstream `package.json`); replaced by the pi-mcp-adapter bridge. **That package is deliberately not a dependency of this repo.** |
| `src/providers/{agents,memory,mesh,state,schema,compact}-provider.ts` | Providers for dropped subsystems |
| `src/runtime/node-process-runtime.ts`, `src/runtime/node-process-child-source.ts` | Unsafe trusted-code escape hatch; imports `src/agents/transports/` and needs `cross-spawn`. `executor.runtime` is therefore fixed at `"quickjs"`. |
| `src/core/compact-controller.ts` | Imports `src/compaction/instructions.ts` |
| `src/ui/dashboard.ts`, `dashboard-model.ts`, `dashboard-presentation.ts`, `dashboard-fabric-graph.ts`, `topology.ts`, `model-picker.ts`, `settings.ts`, `fabric-actor-delivery-selector.ts`, `fabric-actor-tool-selector.ts`, `fabric-host-event-selector.ts`, `fabric-model-selector.ts`, `fabric-thinking-selector.ts` | Dashboard and selector dialogs; spindle has exactly one widget and no overlays |
| `src/ui/transcript-reader.ts` | Only reachable from the deleted dashboard, and its sole remaining import was the non-vendored `src/log-tail.ts`. Dropped instead of vendoring dead code; the `AgentTranscriptReader` re-export was removed from `ui/transcript.ts`. |
| `src/thinking.ts` | Became unused after the config trim, and its thinking-level union (`…\|"max"`) disagrees with the thinking levels the absorbed subagents runner accepts. `config.ts` validates `agents.defaultThinking` against `agents/pi-args.ts`'s `THINKING_LEVELS` instead. |
| upstream `skills/fabric-advisor`, `fabric-ambient`, `fabric-council`, `fabric-fusion`, `fabric-guide`, `fabric-rlm`, `fabric-schema`, `fabric-supervisor`, `fabric-swarm`, `fabric-workflow` | Skills for dropped features. Only `skills/fabric-exec` was vendored, as `<repo>/skills/spindle-exec`. |

## Local modifications

| File | Change |
|---|---|
| *(whole tree)* | Relative import specifiers rewritten `.js` → `.ts` |
| `index.ts` | **Rewritten.** Dropped the actor host-event observers, upstream's slash command, prewalk handoff `message_end` boundary, compaction hook, ESC halt-the-world gate, `resources_discover` bundled-skills contribution, and all `publishHostLifecycle` / `dispatchHostEvent` / `noteMainActivity` wiring. Kept code-preview settings, the capture install, tool ownership/lifecycle, the `tool_result` + `context` skill-dir expansion, the `before_agent_start` guidance (rewritten for the surviving namespaces), and `session_start` / `session_shutdown`. Added the throttled `cleanupOldRuns()` sweep inherited from the deleted `extensions/subagents/index.ts`. |
| `spindle-state.ts` | **Rewritten.** Now holds only config, `ActionRegistry`, the four providers, `SpindleExecutionService`, `SpindleActivityStore`, the subagent run registry, and the parent `SessionRef`. |
| `execution-service.ts` | Trimmed: no Node-process runtime, no schema-enforce branches, no `agents.handoff` deferral, no `authorizer` plumbing. Upstream's `$models` case dropped. **The six discovery cases are spindle-local, not upstream**: `spindle.$providers` / `$catalog` / `$list` / `$search` / `$describe` / `$call` back the guest `tools` namespace (see `runtime/guest-host-refs.test.ts` for the contract). `spindle.$timer` is satisfied inside `runtime/quickjs-runtime.ts` and never reaches this switch. `spindle.$progress` currently has no guest producer (host-side `context.update` drives progress instead) but is kept callable. `guardAgentCall` now guards `agents.run` / `agents.runAll`. The type-check failure path reports the first errors verbatim (activity + trace message), and the emitted source map is forwarded to the runtime so guest stack positions map back to the program. Added a local `UsageWithReasoning` type because the installed `@earendil-works/pi-ai` `Usage` has no `reasoning` field. |
| `spindle-exec-tool.ts` | Tool renamed to `spindle_exec`; `label` is `Spindle`. `description`, `promptSnippet` and the `code` parameter description rewritten for the surviving namespaces. `tokenBudget` parameter and the prewalk handoff block removed; `agentBudget` kept (maps to `maxAgentCalls`). `renderCall` / `renderResult` bodies are otherwise unchanged, except type-check failures: `details.typeErrors` (persisted via `audit/details.ts`) renders as one red `Line L:C: message` row per error with an expand hint, so the TUI shows why the program never ran instead of a bare failure. Exported factory is `createSpindleExecTool`. |
| `config.ts` | Trimmed: removed `mesh`, `memory`, `schema`, `compaction`, `retention`, `mcp` (upstream's own MCP client block) and `prewalk`. `executor.runtime` narrowed to the literal `"quickjs"`. `agents` repurposed to `{ maxPerExecution, timeoutMs, defaultModel?, defaultThinking? }`. `capture.keepVisible` default is `["spindle_exec"]`. **Config file renamed to `spindle.json`** (`<agentDir>/spindle.json`, `<cwd>/.pi/spindle.json`) so spindle never reads or writes pi-fabric's user config; the env override is `PI_SPINDLE_FULL_CODE_MODE`. Upstream's compaction-engine env side effect is gone. |
| `config-migrations.ts` | Untouched. Its legacy `subagents` → `agents` migration is inert for a fresh `spindle.json`; it still provides the `configVersion` guard. |
| `runtime/quickjs-runtime.ts` | `GUEST_SETUP` trimmed: removed `globalThis.{mesh,memory,state,schema,compact,council,rlm,agent,budget}`, `__createActor`, `__handoff`, `__handoffFacts`/`__successfulCalls`, `__workflowAgent`, `__budgetedRun`, `__recordAgentUsage`, `__workflowBudgetTotal`/`__workflowSpentTokens`, `workflow.agent`, `workflow.budget`. **A local `tools` global was added back** (discovery + generic dispatch, upstream's `__toolsBase` shape is gone; core-tool names raise an actionable error pointing at `pi.<name>`). `globalThis.agents` reduced to `{ list, run, runAll }`. `globalThis.mcp` retargeted at `mcp.$list` / `$search` / `$describe` / `$call`, keeping the nested `mcp.<server>.<tool>` Proxy sugar. `SpindleSandboxOptions.tokenBudget` and the token-budget guest global removed. Setup eval filename is `spindle-setup.js`. Local additions beyond the trim: the frozen `process` shim (injected via `options.process`), `pi.bash` extras (`cwd` / `env` / `stdin`, alias-normalized in `__piArgAliases`), `spindle.$timer` host-call short-circuit, and source-mapped error reporting: the transpiled program carries a source map (`options.sourceMap` or the self-transpiled one) and guest stack positions are rewritten to `program.ts:line:column` via `runtime/source-map.ts`; dumped guest errors render as `Name: message` + frames instead of a JSON blob. |
| `runtime/guest-types.ts` | Trimmed to match `GUEST_SETUP` exactly. Removed every interface for dropped subsystems. Upstream's agents API interface replaced with spindle's three-method contract plus `SpindleAgentDefinition` / `SpindleAgentRequest` / `SpindleAgentResult`. Upstream's MCP API interface replaced with the bridge surface plus the Proxy sugar index signature. `FULL_CODE_GLOBAL_DECLARATIONS` gating for `pi` / `extensions` kept verbatim. Local additions beyond the trim: the `tools` (`SpindleToolsApi`) declaration, the `process` shim declaration, `SpindleBashOptions` (`cwd` / `env` / `stdin` + `workdir` aliases) on `pi.bash`, and `type-checker.ts` importing these declarations in its own tests. |
| `runtime/orchestration.ts` | `BLOCKING_ORCHESTRATION_REFS` and the static-detection regex reduced to `agents.run` / `agents.runAll`. |
| `core/tool-ownership.ts` | `SPINDLE_TOOL_NAME` is `"spindle_exec"`. Removed upstream's top-level tool authorizer and `#authorizeTopLevel` (schema-enforce-only), so `SpindleToolLifecycle` takes just `ownsSpindleTool` and `toolCall` is synchronous. |
| `core/action-registry.ts`, `core/skill-prompt.ts`, `core/skill-references.ts`, `audit/details.ts`, `providers/pi-tools-provider.ts`, `ui/transcript-parser.ts` | Tool name is `spindle_exec` in comments and strings. In `ui/transcript-parser.ts` this is functional: it matches the running outer tool call by name. |
| `protocol.ts` | Removed `SpindleInvocationContext.deferHandoff` (handoff is gone). |
| `ui/types.ts` | **Rewritten** as a minimal local type module. See the parity note above. |
| `ui/snapshot.ts` | **Rewritten** to build the reduced snapshot from `state.activity.runs()` plus the subagent run registry. |
| `ui/controller.ts` | **Rewritten.** Kept `start` / `stop` / `#schedulePoll` / `#scheduleRefresh` / `#refresh` / `#renderWidget` and the single `ctx.ui.setWidget(..., { placement: "aboveEditor" })` call. Deleted `openDashboard`, `#pollMesh`, the mesh event buffer, the transcript sources and the dashboard TUI. `WIDGET_ID` is `"spindle"`. |
| `ui/transcript.ts` | Removed the `AgentTranscriptReader` import and re-export (see the trim manifest). |
| `ui/transcript-parser.ts` | `SpindleLogLine` now comes from the new local `ui/transcript-types.ts` instead of `../agents/types.ts`. |

## Removed: approvals & risk subsystem

The upstream approval gate and its LLM auto-approval classifier were removed
wholesale (all risk classes defaulted to `allow` here, so the gate never gated
anything). Deleted `core/approval-controller.ts` and
`core/auto-approval-classifier.ts`. Dropped the `SpindleRisk` type and the
`risk` field from `SpindleActionDescriptor` / `SpindleCapabilityActionHead`
(`protocol.ts`); the `approvals` config block plus `capture.defaultRisk` /
`capture.risks` and their parsing (`config.ts`); `approve` from
`SpindleRegistryInvocationContext`, the `"approve"` invoke stage, and `risk`
from the capability catalog (`core/action-registry.ts`); the
`ApprovalController` wiring, the auto-decision usage aggregation, and the
classifier constructor param (`execution-service.ts`, plus the now-dead
`undefined` arg in `spindle-state.ts`); the per-descriptor `risk` on every
provider (`pi` / `mcp` / `agents` / captured) and on `CapturedToolEntry`
(`capture/catalog.ts`, `capture/interceptor.ts`); and the
`spindle.approval.auto` projection cases (`audit/projection.ts`).

The subagent `tools:` allowlist (`core/tool-allowlist.ts`, `SpindleToolGate`)
is a separate system and is untouched. The `"approve"` member was also removed
from `audit/trace.ts`'s `SpindleExecutionFailureStageV1` union and its `stages`
validator Set. Additionally, `SpindleExecutionTraceRecorder.seal()` now honors
its `error` argument: the caller's concrete failure text (runtime error,
type-check summary) becomes `trace.error` instead of the generic
"Execution failed" label, which is what the transcript renders. This is a
deliberate divergence from upstream pi-fabric: porting
future upstream changes to any of the files above now requires dropping the
risk/approval hunks by hand.

## New spindle files

| File | Purpose |
|---|---|
| `providers/mcp-bridge-provider.ts` | `mcp.*` → the `pi-mcp-adapter` `mcp` gateway tool. **Upstream has a file with the same provider name (`mcp`) that is deliberately not vendored.** |
| `providers/agents-provider.ts` | `agents.*` → the absorbed subagents code. Its `#run` reduces to a pipeline (`#resolveRequests` → start monitor → invoke backend → format results). **Upstream also ships `src/providers/agents-provider.ts`, fronting its own RLM/handoff agent runtime; that file is NOT vendored, and this file is unrelated to it.** |
| `providers/agent-run-monitor.ts` | The widget-facing projection: `SpindleAgentRunRegistry` (the widget's data source) and `RunProgressMonitor`, which turns backend status updates into registry rows + the one-line ticker behind a `start`/`onStatus`/`stop` interface. |
| `ui/transcript-types.ts` | `SpindleLogLine`, copied from upstream `src/agents/types.ts`, so the transcript parser does not import a dropped subsystem. |
| `agents/` | The absorbed `extensions/subagents` code (see below). |
| `providers/spindle-bash-tool.ts` | Spindle's `pi.bash` definition: wraps pi's bash tool with per-call `cwd` / `env` / `stdin` extras (validated, then applied via per-call `BashOperations`); extras-free calls delegate to the base tool unchanged. The `stdin` path delegates to the shared supervised spawn (`sandbox/supervised-spawn.ts`) and routes through the OS-sandbox wrap. |
| `env-snapshot.ts` | The allowlisted environment snapshot injected as the guest's `process` global; secrets never enter the sandbox. |
| `core/arg-redaction.ts` | Redacts `pi.bash` `env` values and `stdin` from recorded surfaces (audits, previews, traces); the live call keeps raw values. |
| `runtime/source-map.ts` | Minimal source-map consumer: decodes the transpile map and rewrites `pi-spindle-guest.js:L:C` stack positions to `program.ts:L:C` in the program the model wrote. |
| `runtime/checker-backend.ts` | The type-checker backend seam: `check` / `transpile` behind one interface, with the stock `typescript` backend as default and runtime-installable alternatives (e.g. a native-compiler process) without touching the checker core. |
| `runtime/guest-host-refs.test.ts` | The guest/host ref contract: runs a probe program through a real sandbox with a recording bridge, asserts every emitted ref is handled and every static `spindle.$*` case is reachable, and that no `fabric.$` names survive a port. |
| `execution-service.test.ts` | Headless execution-service tests over a stub-provider registry: type errors, extension calls, discovery dispatch, phases, agent budget, and source-mapped runtime errors. |
| `runtime/quickjs-runtime.test.ts` | Runtime integration tests: host-call marshalling and rejection, concurrency, logs and truncation, deadline, abort (pre-start and mid-host-call), memory limit, timers, `π` strings, `process` shim, and error-position mapping. |
| `sandbox/policy.ts` | Pure filesystem policy: modes, writable roots, deny patterns, and the config object `@anthropic-ai/sandbox-runtime` expects. |
| `sandbox/manager.ts` | Runtime plumbing: loading `srt`, initializing it for a policy, and the late-bound `bash` operations (supervised by `sandbox/supervised-spawn.ts`). |
| `sandbox/supervised-spawn.ts` | The one supervised process-tree spawn: detached process group, kill-tree on timeout/abort, stdin piping, and the `timeout:<seconds>` / `aborted` error contract, behind one small interface. Two adapters ride on it: the OS-sandbox wrap (`sandbox/manager.ts`) and the `pi.bash` stdin extras (`providers/spindle-bash-tool.ts`), which previously carried two private copies of these mechanics. |
| `sandbox/controller.ts` | The session's live sandbox state. Hands out stable operations whose closures read the *current* policy, so the mode can change mid-session. `readGuard()` hands out the same shape of stable closure for the denyRead roots. |
| `sandbox/protocol.ts` | Bus contract for changing the mode at runtime (`spindle:sandbox-request` / `spindle:sandbox-state`). |
| `sandbox/night-bridge.ts` | Reads the night-mode handshake, so a subagent process inherits the run's policy without any IPC. |
| `sandbox/resolve.ts` | Precedence: config, request, and the floor an active night run imposes. Pure. |

### Filesystem sandbox

Upstream has no filesystem guardrail: `providers/pi-tools-provider.ts` built the
seven core tools with no options, so a `pi.bash` inside `spindle_exec` had the
full rights of the pi process. That is fine when a human is watching and a
liability during an unattended run.

The threat model is accidents, not adversaries: the goal is that an overnight
agent cannot `rm -rf ~`. Two enforcement points, one policy:

| Tool | Mechanism | Why |
|---|---|---|
| `bash` | `@anthropic-ai/sandbox-runtime` (Seatbelt on macOS, bubblewrap on Linux) | A shell command can do anything; only the kernel can bound it |
| `write`, `edit` | direct path check against the write allowlist | They take absolute paths and never reach a shell, so the check is exact and needs no OS support |
| `read`, `grep`, `find`, `ls` | direct path check against the `denyRead` roots (`SandboxController.readGuard()` → `PiToolsSandbox.readGuard`) | The tools keep pi's own definitions (image handling / truncation / offsets stay byte-identical), but while a policy enforces, the `denyRead` roots that bind `bash` bind the read tools too. Without this, a sandboxed program could pull a credential through `pi.read` and send it out through any channel `bash` may reach. Reads outside the denied roots are untouched |

`@anthropic-ai/sandbox-runtime` is an `optionalDependency`, imported through a
variable specifier. A missing install or an unsupported platform degrades to
"path guards only" with a warning, instead of breaking session startup.

Config lives under `sandbox` in `spindle.json`. It defaults to `mode: "off"`,
because an interactive session legitimately writes outside its cwd (notes,
sibling repos, agent files); enforcement is opt-in per project, or turned on for
the duration of a night run.

```json
{
  "sandbox": {
    "mode": "workspace-write",
    "allowWrite": ["~/.pi/agent/night"],
    "denyRead": ["~/.ssh", "~/.gnupg"]
  }
}
```

The mode names mirror Codex CLI's, since that vocabulary is already familiar:

| Mode | Writable |
|---|---|
| `off` | everything (no enforcement) |
| `read-only` | temp dirs only |
| `workspace-write` | cwd, plus tool caches (`GOCACHE`, `GOMODCACHE`, the platform cache home, npm/Cargo), plus configured extras |
| `full` | everything (no enforcement, named to be explicit about it) |

Two known holes, both deliberate: `~/.aws` stays readable because SOPS/KMS
decryption needs it, and granting Docker socket access defeats the filesystem
boundary entirely, since a container can bind-mount `/`.

#### Changing the mode mid-session

The mode cannot be decided once at startup: an unattended run wants enforcement
that an interactive session would find obstructive, and it starts hours after the
session did. pi builds its tool definitions once and bakes the operations in, so
the operations `SandboxController` hands out are **stable objects whose closures
read the current policy on every call**. Turning enforcement on is a policy swap,
not a re-registration. When nothing is enforced, `bash` delegates to pi's own
`createLocalBashOperations()`, so an unsandboxed session behaves exactly as it did
before any of this existed.

Two delivery paths, one policy source:

| Process | How it learns the policy |
|---|---|
| The session that ran `/night start` | `spindle:sandbox-request` on pi's event bus; `policy: null` reverts to `spindle.json` |
| Subagent `pi` processes | `sandbox` in `~/.pi/agent/night/active.json`, read at startup by `sandbox/night-bridge.ts` |

Subagents are separate processes, so the parent's bus never reaches them; they
already read that file for the report path and the hard rules. Reading it also
means the policy survives a `/reload`.

This is extension-level trust, not model-level: `pi.events` is not reachable from
inside `spindle_exec`, so the agent cannot request its own sandbox. Payloads are
still validated (`parseSandboxRequestEvent`) rather than trusted.

#### `/sandbox`

The only slash command Spindle registers.

| Invocation | Effect |
|---|---|
| `/sandbox` or `/sandbox status` | Mode, source, whether a night run holds it, and whether `bash` is OS-enforced or path-guarded only |
| `/sandbox read-only` | Restrict now |
| `/sandbox workspace-write [path…]` | Restrict now, granting extra writable roots |
| `/sandbox off` | Revert to what `spindle.json` says |

`off` is a *revert*, not a forced "no enforcement", so it can never loosen the
configured baseline. While enforcing, the footer shows `🔒 workspace-write`, or
`🔒 workspace-write (paths only)` when the OS backend is unavailable.

#### Precedence, and why a night run cannot be unsandboxed

`sandbox/resolve.ts` combines three inputs. Modes are ranked by how much they
restrict (`read-only` > `workspace-write` > `off` = `full`), and an active night
run is a **floor**, never a ceiling:

| Config | Request | Night run | Effective |
|---|---|---|---|
| `off` | - | - | `off` |
| `off` | `read-only` | - | `read-only` |
| `read-only` | `off` (revert) | - | `read-only` |
| `off` | `off` | `workspace-write` | **`workspace-write`**, request refused and reported |
| `off` | `full` | `workspace-write` | **`workspace-write`**, request refused and reported |
| `off` | `read-only` | `workspace-write` | `read-only` (tightening is allowed) |

The night's own writable roots (its working copy, the report, the ledger) are
always unioned in, so a tightening request cannot cut the run off from the files
it has to write. A refused request is surfaced as a warning rather than silently
appearing to work, and it is not remembered: when the run ends, night-mode emits
a revert that clears it.

### Directory name collision warning

`extensions/spindle/agents/` holds the **absorbed subagents extension**. It is
**unrelated** to upstream pi-fabric's `src/agents/` (RLM / handoff / transports),
which is dropped and must never be vendored into it. When reviewing an upstream
diff, treat every `src/agents/**` change as out of scope for this directory.

## Absorbed `extensions/subagents`

The standalone `subagents` extension (and its `subagent` tool) was deleted; its
implementation now lives in `extensions/spindle/agents/` and is reachable only
through the `agents.*` sandbox namespace.

Moved verbatim (no import edits needed — all relative imports were siblings):
`backend.ts`, `constants.ts`, `discovery.ts`, `frontmatter.ts`, `grid.ts`,
`headless.ts`, `herdr-backend.ts`, `herdr.ts`, `pane-lifecycle.ts`, `paths.ts`,
`pi-args.ts`, `progress.ts`, `request.ts`, `child-extension.ts`, `run.ts`,
`settings.ts`, plus all 11 `*.test.ts` files. (`herdr.ts` was later split into
`herdr-parse.ts` / `herdr-transport.ts` / `herdr-client.ts` — see "herdr client"
below.)

Not moved: `index.ts` and `tool.ts` (they defined the standalone extension and
tool). `SessionRef`, `DEFAULT_RUN_TIMEOUT_MS` and the `buildRunRequests`
orchestration were salvaged into `providers/agents-provider.ts`; the ticker and
`PROGRESS_TICK_MS` into `RunProgressMonitor` (`providers/agent-run-monitor.ts`);
the throttled `cleanupOldRuns()` sweep into `index.ts`.

`agents/pi-args.ts`'s `childExtensionPath()` resolves `child-extension.ts`
relative to `import.meta.url`, so it keeps working after the move with no edit —
`agents/pi-args.test.ts` asserts this. (Formerly `result-tool.ts`, which hosted
a `submit_result` tool; that tool was removed in favor of reading the child's
final assistant message, and the file was trimmed to just registering the
allowlist flag.)

### herdr client

`herdr.ts` was split into three modules by concern, with a transport seam:

- `herdr-parse.ts` — pure CLI-JSON parsers (`parseHerdrJson`, `parseTabs`,
  `parseTab`, `parsePaneId`, `findAgentStatus`, `isPaneBusyError`, `paneLabel`)
  over the shared `lastJsonLine` scanner. No I/O; exported for unit testing.
- `herdr-transport.ts` — the `HerdrTransport` seam and its one production
  adapter `execFileTransport` (shells out to `herdr`), plus the env helpers
  `isInHerdr` / `currentWorkspaceId`.
- `herdr-client.ts` — `HerdrClient`, the typed method wrappers (arg building +
  the `agent start` busy-retry + the herdr-0.7.5 `agent wait`), delegating
  parsing to `herdr-parse.ts`. Exports a default `herdr` instance bound to
  `execFileTransport`; `herdr-backend.ts` uses it, `pane-lifecycle.ts` gets its
  probe from `HerdrClient.statusProbe`.

The seam has two real adapters: `execFileTransport` in production, and an
in-memory `HerdrTransport` in `herdr-client.test.ts` that replaces the old
fake-`herdr`-on-`PATH` hack, so the retry loop and `agent wait` mapping are
unit-tested directly.

### Rendering adaptation

`progress.ts` is **unmodified** (so `progress.test.ts` still passes) but its ANSI
block is no longer emitted as raw tool text. Instead `RunProgressMonitor`
(`providers/agent-run-monitor.ts`), which `agents-provider.ts` drives via
`start`/`onStatus`/`stop`:

- mirrors each `AgentProgress` row into `SpindleAgentRunRegistry` as a
  `SpindleUiAgent`-shaped record (`id`, `name`, `status`, `startedAt`,
  `updatedAt`, `currentTool`, `error`, `runId`), which `ui/snapshot.ts` feeds to
  `ui/widget.ts`'s existing `agentLines()`;
- calls `renderProgress(...)` once per tick, flattened to a single line, as the
  `context.update(...)` body, so `ui/spindle-render.ts`'s
  `singleCallProgressLine` / `renderNestedAgentToolLines` /
  `renderSpindleMulticallPartial` render the in-flight ticker;
- (the provider) returns a structured `SpindleAgentResult` so `ui/structured.ts`'s
  `formatSpindleValue` formats it, instead of the old hand-rolled markdown.

`SpindleAgentRun.runId` is set to `context.parentToolCallId`, which is also the
`SpindleActivityRun.id`, so the widget can associate rows with the running program.

### Subagent tool allowlists

An agent definition's `tools:` frontmatter can no longer be enforced with pi's
own `--tools` filter: the child must keep `spindle_exec` (its only tool path in
full code mode), and keeping it would re-expose every core tool through `pi.*`.
So the enforcement moved into the sandbox:

- `agents/pi-args.ts` appends `spindle_exec` to `--tools` (the child's only
  tool path in full code mode) and forwards the declared list via
  `--${ALLOWED_TOOLS_FLAG}` (`--spindle-allowed-tools`, declared in
  `agents/constants.ts`).
- The flag is registered by `agents/child-extension.ts`, loaded via
  `--extension` only when the parent restricts tools. pi rejects the same flag
  from two extensions, so Spindle does not also register it; it reads the value
  off argv (`getFlag` only resolves flags the reading extension registered).
- `core/tool-allowlist.ts` parses it and owns `SpindleToolGate`, the single
  module that decides "may this tool be called". Absent/blank means an
  unrestricted gate. `allows(name)` / `assert(namespace, name)` are the whole
  enforcement surface; the transport carve-out and "undefined = unrestricted"
  live inside the gate.
- `spindle-state.ts` builds one `SpindleToolGate` (via `fromArgv`) and threads
  that gate into `PiToolsProvider`, `CapturedToolsProvider` and
  `SpindleExecutionService`.
- `runtime/guest-types.ts` strips disallowed `pi.*` members from `PiToolsApi`
  (and the `pi` global when nothing survives) by consulting the gate's
  `allows()`, so the declared schema matches what may be called. The string
  surgery stays here (it owns the schema format; `core/` must not depend on
  `runtime/`). That is schema shaping only: `type-checker.ts` filters out
  TS2339 (`TYPE_CORRECTNESS_CODES`), so the actual rejection comes from the
  providers, which call `gate.assert(this.name, action)` from `describe()` —
  undefined there would surface as the misleading "Unknown Spindle action".

`spindle_exec` is always allowed: it is the child's only tool path in full code
mode and is never callable from inside the sandbox, so gating it would be both
pointless and fatal. A restricted subagent still answers through its final
assistant message, not a tool, so no result-channel tool needs a carve-out.

Scope: the allowlist gates `pi.*` and `extensions.*` only. `mcp.*`, `agents.*`
and `workflow.*` are not tools in that sense and stay available.

### subagents domain vocabulary

(Merged from the deleted `extensions/subagents/CONTEXT.md`. Keep names in code
and docs aligned with these.)

- **run**: one custom-agent invocation (one child `pi` process). Modelled by
  `RunRequest` in, `RunResult` out.
- **batch**: the set of runs launched together by a single `agents.run` /
  `agents.runAll` call. Runs in a batch share one `runId` and one `RunContext`.
- **run backend**: the seam that turns a batch of `RunRequest`s into
  `RunResult`s. One interface (`RunBackend`), two **adapters**:
  - **headless adapter** (`headless.ts`): spawns `pi` child processes, waits for
    exit.
  - **herdr adapter** (`herdr-backend.ts`): launches `pi` in live herdr panes,
    waits for each pane to settle. Its completion rule (`waitForRunCompletion`,
    `RunOutcome`, `outcomeError`) lives in `herdr-completion.ts`, not the shared
    `run.ts`, because only herdr needs it.
  `backend.ts` owns `selectBackend()`, which picks the adapter by environment.
  `RunResult` is a discriminated union on `backend` (`"headless"` carries
  `exitCode`, `"herdr"` carries `paneId`) so backend-specific diagnostics do not
  leak as bare optionals into the shared type; `run.ts`'s `baseResult` builds the
  shared fields both adapters populate.
- **run context** (`RunContext`): the ambient inputs a backend needs for a batch
  (session id/file, runId, cwd, timeout, abort signal, status callback).
- **output resolution**: the rule that decides a run's final output text and
  whether it succeeded, from the child session transcript (the agent's last
  assistant message), then a backend-specific fallback source. The parent
  persists the resolved text to the run-dir artifact (or a caller `output:`
  override). Lives in `agents/output.ts`, which owns the run output artifact
  end to end: the `output` override lifecycle (`normalizeOutputOverride`,
  `indexOutputOverride`/`planBatchOutputs`, `resolveOutputOverride`/`outputPathFor`)
  and resolution (`readLastAssistantText`, `resolveRunOutput` taking a
  `RunOutputSource`). Persisting creates the destination's parent directories
  and reports a failed write, and a result carries `outputPath` only when the
  file actually landed, so the tool never claims an artifact that is not there.
  `paths.ts` keeps only the run-dir layout and the sweep;
  each adapter passes just its backend `fallback` + `finishedCleanly`.
- **status probe**: the read-only view of a herdr pane's agent status that the
  pane-lifecycle machine polls to decide when a run has finished or its pane is
  gone.

## MCP bridge contract

`providers/mcp-bridge-provider.ts` resolves the `mcp` registered tool lazily
through `CapturedToolCatalog.get("mcp")` and invokes `entry.wrappedTool.execute`
with `ctx.signal` and `ctx.nestedToolCallId`.

| Spindle action | Sandbox call | pi-mcp-adapter gateway params |
|---|---|---|
| `mcp.$call` | `mcp.call(server, tool, args)` / `mcp.<server>.<tool>(args)` | `{ tool, args, server? }` |
| `mcp.$list` | `mcp.list(server)` / `mcp.list({ server? })` / `mcp.<server>()` | `{}` or `{ server }` |
| `mcp.$search` | `mcp.search({ query, server?, regex?, includeSchemas? })` | `{ search, server?, regex?, includeSchemas? }` |
| `mcp.$describe` | `mcp.describe({ tool })` | `{ describe }` |
| `mcp.$connect` | `mcp.connect(server)` | `{ connect: server }` |

Two invariants:

1. **Fail at use, never at startup.** The constructor does not touch the
   catalog. A missing `pi-mcp-adapter` surfaces as an actionable error thrown
   inside the sandbox on the first call, so a session always starts and a
   program that never touches `mcp.*` is unaffected.
2. **No pre-fetch.** `pi-mcp-adapter` connects servers lazily. `list()` and
   `describe()` return four static descriptors and never call the gateway;
   eagerly enumerating tools would force every configured server to connect and
   could trigger interactive OAuth flows.

Results are normalized to `{ text, content, structuredContent }` using a copy of
the deleted `src/providers/mcp-provider.ts`'s `normalizeMcpResult` semantics; a
gateway error is rethrown with the gateway's text. `AgentToolResult` carries no
`isError`, so failure detection relies on the gateway throwing (with a
defensive check on `details.isError`).

## Dependencies added to the repo

`@jitl/quickjs-singlefile-mjs-release-sync`, `quickjs-emscripten-core`, `shiki`,
`diff`, `yaml`, `typescript` (`^6.0.3`, matching upstream) as `dependencies`;
`@types/node` as a devDependency. `typebox` was already a peerDependency.
**Upstream's embeddable MCP client package and `cross-spawn` are deliberately absent.**

`@anthropic-ai/sandbox-runtime` is an **optionalDependency** used by `sandbox/`.
It is not upstream's: upstream ships no filesystem sandbox. Linux also needs
`bubblewrap`, `socat` and `ripgrep` on the host for it to enforce anything.

The QuickJS WASM variant (`@jitl/quickjs-singlefile-mjs-release-sync` loaded via
`newQuickJSWASMModuleFromVariant`) was validated to instantiate and evaluate in
this repo under `node --import tsx` with ESM + `.ts` specifiers before any
vendoring was done. No wasmfile fallback substitution was needed.

## Maintenance recipe — pulling upstream changes

1. Update the clone and check out the newer tag:

   ```sh
   cd /tmp/pf-probe && jj git fetch && jj new <newer-tag>
   ```

2. Get the upstream diff for the **parity set** (upstream paths, so
   `fabric`-named files are named as upstream names them):

   ```sh
   jj diff --from v0.28.2 --to <newer-tag> -- \
     src/ui/fabric-render.ts src/ui/core-tool-render.ts src/ui/code-preview.ts \
     src/ui/code-preview-shell.ts src/ui/highlight.ts src/ui/format.ts \
     src/ui/preview-lines.ts src/ui/fabric-code-parser.ts src/ui/diff-background.ts \
     src/ui/row-balance.ts src/ui/spinner.ts src/ui/structured.ts \
     src/ui/transcript-sanitization.ts src/ui/widget.ts src/ui/word-diff/
   ```

   **The patch will not apply as-is.** Because the fork is renamed, porting is no
   longer a verbatim copy: translate the patch through the rename mapping first
   (both the path rows and the identifier rows), then re-run the specifier
   rewrite on the touched files. Concretely, per file:

   ```sh
   jj diff --from v0.28.2 --to <newer-tag> -- src/<upstream path>
   # then, on the ported local file:
   perl -pi -e 's/FABRIC/SPINDLE/g; s/Fabric/Spindle/g; s/fabric/spindle/g' \
     extensions/spindle/<local path>
   perl -pi -e 's{(from\s+")(\.\.?/[^"]*)\.js(")}{$1$2.ts$3}g' \
     extensions/spindle/<local path>
   ```

   The blanket `fabric` → `spindle` substitution is only safe inside
   `extensions/spindle/**`; never run it over `CONTEXT.md`, whose provenance
   references (upstream project name, repo URL, tag, SHA, upstream paths and
   upstream identifier names) must stay literally correct.

3. Review everything else and ignore changes under a dropped directory by
   design:

   ```sh
   jj diff --from v0.28.2 --to <newer-tag> --stat -- src/
   ```

4. For the rewritten/trimmed files — local `index.ts`, `spindle-state.ts`,
   `execution-service.ts`, `spindle-exec-tool.ts`, `config.ts`,
   `runtime/quickjs-runtime.ts`, `runtime/guest-types.ts`,
   `runtime/orchestration.ts`, `core/tool-ownership.ts`, `protocol.ts`,
   `ui/{types,snapshot,controller,transcript}.ts` — read the upstream diff
   (upstream paths per the mapping) and port by hand, applying the identifier
   mapping as you go. `guest-types.ts` and `quickjs-runtime.ts`'s `GUEST_SETUP`
   must stay in lockstep or every program fails type-check.

5. Bump the pinned tag and SHA in the table at the top of this file.

6. Verify: `npm run typecheck` and `npm test` must both exit 0, plus the rename
   invariants:

   ```sh
   fd fabric extensions/spindle skills          # must be empty
   rg -i fabric extensions/spindle skills -g '!CONTEXT.md' -g '!guest-host-refs.test.ts'   # must be empty
   rg 'fabric\.\$' extensions/spindle -g '!guest-host-refs.test.ts'   # must be empty
   ```

   (`runtime/guest-host-refs.test.ts` names `fabric.$` on purpose: it is the
   assertion that guards the rename, so the exclusions above keep the recipe
   exact.)
