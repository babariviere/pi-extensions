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

## Backports taken after the pin

Upstream moved on (0.76.x at the time of writing). These behaviors were ported
or adapted by hand on top of the pinned fork; each is a self-contained module
plus its wiring, and none pulls in a dropped subsystem.

| Local file | Upstream origin | What it buys |
|---|---|---|
| `runtime/quickjs-runtime.ts` (`setMaxStackSize`) | same call upstream | runaway guest recursion raises a guest error instead of walking the host stack |
| `spindle-exec-arguments.ts`, `run-display.ts`, `runtime/guest-code-repair.ts` | `src/fabric-exec-arguments.ts`, `src/run-display.ts`, `src/runtime/guest-code-repair.ts` | `prepareArguments` repairs code arrays, unquoted path heads, JSON-encoded payload maps, nullish optionals and a bare `display` string before Pi validates the call |
| `type-error-guidance.ts`, `runtime/core-tool-properties.ts` | same names upstream (property table adapted to spindle's inline `PiToolsApi`) | one actionable recovery hint next to type-check diagnostics |
| `failure-progress.ts` | `src/failure-progress.ts` | a failed program names the calls that already succeeded |
| `output-budget.ts` | `src/output-budget.ts` | oversized output spills to a temp artifact instead of losing its middle |
| `config.ts` (`executor.maxTimeoutMs`), `execution-service.ts` (`requestedTimeoutMs`) | same fields upstream | a per-invocation `timeoutMs` raises (never lowers) the program deadline |
| `runtime/dynamic-guest-types.ts` | `src/runtime/dynamic-guest-types.ts` (mcp section rewritten) | `extensions.<tool>` is typed from the live captured catalog; `mcp` is typed from the on-disk MCP tool cache as an indexed tool map, so generation never connects a server |
| `core/action-repair.ts`, `providers/arg-normalization.ts` | same names upstream | near-miss action names and argument keys repair from the declared catalog/schema, with didactic failures |
| `core/pi-bash-error.ts` | `src/core/pi-bash-error.ts` | `pi.bash({ settle: true })` keeps its exit status across `tool_result` middleware |
| `core/core-override-guidance.ts` | `src/core/core-override-guidance.ts` | an exact-name core override keeps its authored prompt text in full code mode |
| `ui/highlight.ts` (dynamic `import("shiki")`) | upstream's startup-perf change | the full shiki entry stays out of extension startup |

The `spindle_exec` named-payload argument is `payloads`. `strings` is still
accepted and silently remapped in `prepareArguments`, but it is no longer
declared in the tool schema or named in any prompt surface, so nothing teaches a
model to reach for it.

## Upstream drift audit

Audited 2026-09-02 against upstream `main` at `1a71fff54d9bfc03de4a8df925df15e65bc82392`
(`0.76.2`). **380 commits** since the pinned commit. Recorded here so the
"what is pi-fabric doing that we aren't" question is answered from this table
instead of re-derived.

The important correction: at the pin, upstream **already had** `actors/`,
`mesh/`, `memory/`, `schema/`, `state/`, `prewalk/`, `topology/` and
`compaction/`. Those are **trims** (see the removal sections below), not drift.
Only three top-level subsystems are genuinely new since the pin.

| New upstream subsystem | Upstream docs | What it is | Verdict here |
|---|---|---|---|
| `src/components/` | `docs/components.md`, `docs/component-calculus.md`, `docs/provider-component-calculus.md` | supervised third-party provider plugins: staged activation, provider generations, effect scopes, LIFO unwind, rolling replacement without host downtime | **skip** — solves live provider hot-swap for a long-running multi-tenant host. A single CLI session restarts the process |
| `src/residency/` | `docs/residency-runtime.md` | resident host process so `agents.create({ residency: "durable" })` actors outlive the parent TUI, with ownership leases and adoption fencing | **skip** — a background process surviving session exit is a new failure and attack surface. `agents/` here is herdr-pane backed; an unattended run is a pane, not a daemon |
| `src/speculation/` | `docs/speculation.md` | pre-launches literal read-only calls while the model is still streaming `code`, serves the cached result if the mutation epoch is still fresh | **the one worth revisiting.** Bounded blast radius (closed pure-read ref set, take-once serving) and a real latency win. Only port if `spindle_exec` startup latency is ever measured as a problem |

Commit mix over the 250 commits the compare API returns (of 380; GitHub caps the
range, so this is a sample, not the full history): 87 `chore`, 59 `fix`,
46 `feat`, 12 `docs`, 7 `test`, 6 `refactor`, 2 `perf`. `feat` scopes cluster on
`ui` (5), `prewalk` (5), `agents` (5), `components` (4), `capture` (4),
`settings` (3), `core` (3) — i.e. mostly the dashboard, the component plane, and
subsystems trimmed here. The `capture` and `core` work is the category most
likely to contain further backport candidates; individual commits were not read.

Where this fork is **ahead** of upstream: the whole `sandbox/` subsystem.
Upstream has no filesystem guardrail at all, `pi.bash` there runs with full
process rights, and its `node-process` / `bun-process` runtimes are documented
as carrying no security boundary. `SpindleExecutorRuntime` is narrowed to the
literal `"quickjs"` in `config.ts`, so there is no untyped or unsandboxed escape
hatch to re-enable.

External evidence weighed at the same time, for the record: the one independent
benchmark ([r/PiCodingAgent Kaggle eval](https://www.reddit.com/r/PiCodingAgent/comments/1vjs5cs/testing_pirlm_and_pifabric_on_my_kaggle_eval/))
had neither pi-fabric nor pi-rlm beating default Pi, with code mode scoring
worse. The case for code mode itself rests on
[Anthropic's code-execution-with-MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
and [Cloudflare's Code Mode](https://blog.cloudflare.com/code-mode/), both of
which argue for the single-programmable-tool shape this fork keeps, not for the
orchestration layers it drops. [Cognition's "Don't Build Multi-Agents"](https://cognition.ai/blog/dont-build-multi-agents)
is the standing argument against council and swarm fan-out: subagents handed a
task string instead of the full parent trace make conflicting implicit
decisions.

## Sandbox surface

Globals inside `spindle_exec`:

- `pi.*` — Pi core tools (full code mode only), via `providers/pi-tools-provider.ts`
- `extensions.*` — tools registered by sibling extensions, via `capture/` + `providers/captured-tools-provider.ts`
- `tools.*` — cross-provider discovery and generic dispatch (full code mode only): `providers` / `catalog` / `list` / `search` / `describe` / `call` over every registered provider
- `mcp.*` — MCP tools from `~/.pi/agent/mcp.json`, served by spindle's own MCP client (`mcp/client-hub.ts` behind `providers/mcp-client-provider.ts`)
- `agents.*` — custom markdown subagents, via `providers/agents-provider.ts` + `agents/`
- Host APIs, via `runtime/guest-polyfills.ts`: `TextEncoder`/`TextDecoder`,
  `URL`/`URLSearchParams`, `atob`/`btoa`, `structuredClone`, `crypto`
  (`getRandomValues`/`randomUUID` only), `queueMicrotask`, `performance`, and
  `AbortController`/`AbortSignal`. The engine ships none of these, so each is
  guest source injected only when the program text mentions it. There is
  deliberately no `fetch`, `crypto.subtle` or `WebAssembly`: they are
  capabilities rather than conveniences, and the host-call table (behind the
  filesystem sandbox and the MCP read-only policy) has to remain the only route
  out of the sandbox.

  `Intl` and `Atomics` are absent and unfixable by lib choice, since `lib.es5`
  declares both. They are replaced by objects that throw a named
  `NotSupportedError`, and the `toLocaleString` family throws when handed a
  locale rather than silently ignoring it, because the engine is built without
  ICU and a wrong answer that looks right is worse than no answer.

  A signal passed to a host call is not just a local promise race: the runtime
  tags the call with a guest-generated id, gives it its own host-side
  `AbortController` chained to the program-wide one, and an abort sends
  `spindle.$cancel` back through the bridge, so the in-flight work is really
  cancelled and its siblings are not. `mapLimit` takes a signal too and stops
  launching further items.

  The language level is ES2025, matching what the engine actually implements
  (see `runtime/engine-lib.test.ts`); the declared `lib` was ES2022 while the
  engine was already ahead, which did not make the newer APIs unavailable, only
  untyped, since TS2339 is filtered.
- `mapLimit(items, fn, N)` — bounded-concurrency fan-out, the one concurrency
  primitive `Promise.all` cannot express (its inputs have already started, so it
  can never cap width). A bare global: there is no `workflow` namespace.
  `Promise.all` is instrumented to emit the same activity span when called with
  4 or more entries, so a wide fan-out is observable on the path models actually
  use (1,690 of 11,054 recorded programs, vs 47 for the old `workflow.parallel`).
  The removed `workflow.{pipeline,phase,item,event,log,configure}` members and
  the bare `parallel` / `pipeline` / `phase` / `log` aliases had 0-7 calls each
  across that same corpus.

  Per-item progress survived the removal of `workflow.item`, but it is now
  **inferred rather than declared**: `mapLimit` and the instrumented
  `Promise.all` already know each element's index, total and outcome, so they
  emit `spindle.$items` themselves and the program is asked for nothing. This
  is the structural fix for why `workflow.item` was never called once: its
  payoff (a nicer widget) was invisible to the model, whose only signal is the
  returned value, so decorative instrumentation was pure cost. Transitions are
  batched (32 entries or 120ms, plus a final flush) so a 200-item fan-out does
  not cost 400 host round-trips, labels come from the element itself (a string,
  or a conventional `path` / `file` / `id` / `name` key, else `#index`), and
  fan-outs narrower than 4 emit nothing at all. Flush failures are swallowed:
  progress must never mask the program's own outcome.

  Items alone render nothing. The **only** consumer of `run.items` in the whole
  UI is `phaseProgress()` in `ui/widget.ts`, which filters by `phaseId` and is
  reached only when `run.currentPhaseId` is set; `currentPhaseId` is written
  only by `activity/store.ts` `phase()`. Removing `workflow.phase` therefore
  left that entire render path dark. `spindle.$spanStart` now opens a phase for
  every **top-level** fan-out (`fan-out ×N`, `total` = the width, keyed by the
  span id so consecutive fan-outs stay distinct), which makes the existing
  renderers light up with **no edit to any parity-set file**: items inherit
  `currentPhaseId` automatically at `store.ts:246`, and the `◆` chips in
  `spindle-exec-tool.ts` read `ctx.phases`. A nested span (a wide `Promise.all`
  inside a `mapLimit` mapper) deliberately opens no phase, because
  `store.phase()` completes the previous phase and a child would otherwise
  close its own parent's.

  `spindle.$spanEnd` closes the fan-out's phase through
  `activity/store.ts` `completePhase()`, so a finished fan-out does not read as
  `running` until the program ends. `currentPhaseId` is deliberately left
  pointing at the finished phase, so the widget keeps rendering its final
  totals rather than going blank. The same handler folds the fan-out's tally
  into the phase name (`fan-out ×40 (38 ok, 2 failed)`), which the `◆` chips in
  `spindle-exec-tool.ts` already render: no second surface was added for it.

  A note on where the API is *taught*. `runtime/guest-types.ts` is compiler
  input, not prompt text: it is read only by `runtime/type-checker.ts` and
  `runtime/core-tool-properties.ts` and is never sent to the model. So breadth
  there is free, and the unions should stay **wide** (every alias
  `arg-normalization.ts` and `__piArgAliases` accept) so that an accepted call
  never fails type checking. Narrowing them was tried and reverted: it bought
  no tokens, and it forced 2769 / 2739 / 2353 into the advisory set in
  `type-checker.ts`, which silently gave up type-level typo detection on every
  `pi.*` argument. The single model-facing statement of the return-shape rule
  and the one taught spelling per tool lives in `FULL_CODE_GUIDANCE` in
  `index.ts`. Keep the declarations wide and the guidance narrow.
- `process` — minimal shim built from `env-snapshot.ts`: allowlisted `process.env` (HOME, USER, LOGNAME, SHELL, PWD, PATH, LANG, LC_*, TERM, TMPDIR, XDG_*), `process.platform` / `process.arch`, `process.cwd()`. No secret ever enters the guest.
- `print`, `console`, `π` (named payloads; the `payloads` argument, legacy alias `strings`), `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`
- `τ` — the session-scoped scratchpad (`session-store.ts`), reached through five
  host calls (`spindle.$stateGet` / `$stateSet` / `$stateKeys` / `$stateDelete` /
  `$stateClear`). `τ = 2π` is the mnemonic and the semantics are deliberately
  *not* symmetric: `π` is per-call, read-only and infallible, `τ` is
  cross-program, mutable and failable. That asymmetry is why it is a method API
  (`τ.set(k, v)`) and not property assignment on a Proxy. A write that can be
  refused (bad key, non-serializable value, budget) must not read like a local
  assignment, and `delete` / `keys` / `clear` have nowhere natural to live on a
  property surface.

  Values are stored as JSON text, which enforces that nothing with identity
  (closure, socket, handle) can appear to survive a context that is torn down
  between programs, and makes the byte accounting exact. Over a budget the write
  **throws and names the held keys** instead of evicting: silently dropping the
  entry a later program depends on turns a limit into a nondeterministic bug.

  The store is owned by `SpindleState`, for the same reason as the agent run
  book: it has to outlive one `spindle_exec` program. It is reset on session
  start and teardown and never persisted.

  Discoverability is half the feature and does not live in the store: the model
  cannot see state it did not write this turn, so a program that **touched** τ
  gets `SpindleExecutionResult.stateKeys` and a `τ keys: name (size)` line on its
  result. A program that never mentions the scratchpad is told nothing about it.

  Each operation reports itself for the TUI, and that report is split across two
  channels on purpose. The **durable trace** keeps the key (an identifier the
  program chose) and the shape of what happened — bytes, `replaced` / `found` /
  `deleted` / `cleared` — through explicit `spindle.state.*` cases in
  `audit/projection.ts`. The **value** never enters it: that allowlist is the
  trace's confidentiality boundary, and a τ value can be anything the program
  read. So the preview rides the live partial-update channel instead
  (`SpindleStateNote` → `readSpindleStateNotes` → `applySpindleStateNotes`), the
  same route the write previews take. A reloaded transcript therefore keeps the
  row, the key and the size, and loses only the content. Without that echo the
  namespace is a set of names the model has to remember, which is how a hidden
  store becomes a source of guessed keys. The `$stateSet` trace records the key
  only, never the value.

Deliberately absent: `memory`, `state`, `schema`, `compact`, `mesh`,
`council`, `rlm`, `agent()`, `budget`, `workflow.agent`, `workflow.budget`.
(`state` there is upstream's mesh state layer, which stays dropped; the local
`τ` scratchpad above is spindle's own and unrelated to it.)

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

The `fabric.$*` → `spindle.$*` row spans a host/guest seam that no
type-checker covers: the guest half lives inside the `GUEST_SETUP`
string literal in `runtime/quickjs-runtime.ts`, the host half in the host-call
table in `host-calls.ts` (dispatched by `execution-service.ts`). They must be renamed together; a mismatch
fails only at runtime, silently. Two guards exist: after any port,
`rg 'fabric\.\$' extensions/spindle` must be empty, and
`runtime/guest-host-refs.test.ts` executes every guest API against a recording
host bridge and asserts each emitted ref is handled (a `host-calls.ts` table
entry, a runtime-internal handler such as `spindle.$timer`, or a registry
provider namespace) and that every static `spindle.$*` table entry is reachable.

## Render parity set

These files carry **no hand edits**. They differ from upstream `v0.28.2` by
exactly three mechanical passes, and nothing else:

1. the `.js` → `.ts` relative-import-specifier rewrite described below,
2. the `fabric` → `spindle` rename from the mapping table above (which also
   renamed two of the files themselves), and
3. the repo-wide biome format (`npm run fmt`, upstream pi's settings: tabs,
   `indentWidth` 3, `lineWidth` 120).

So they are **not byte-identical to upstream** — do not assume a clean `diff`.
Still, do not edit them by hand: port upstream changes verbatim, re-apply the
first two passes, then run `npm run fmt`.

`ui/spindle-render.ts`, `ui/core-tool-render.ts`, `ui/code-preview.ts`,
`ui/code-preview-shell.ts`, `ui/highlight.ts`, `ui/format.ts`,
`ui/preview-lines.ts`, `ui/spindle-code-parser.ts`, `ui/diff-background.ts`,
`ui/row-balance.ts`, `ui/spinner.ts`, `ui/structured.ts`, `ui/word-diff/*`,
`ui/widget.ts`, `ui/transcript-sanitization.ts`

Also currently carrying no hand edits (same two mechanical rewrites only; not
part of the guaranteed parity contract, but useful to know):
`activity/types.ts`, `audit/index.ts`,
`core/{call-preview,pi-tools,skill-dir,tool-result-proxy}.ts`,
`providers/write-preview.ts`, `async-settlement.ts`,
`config-migrations.ts`, `host-compatibility.ts`, `util.ts`.

`activity/store.ts` **does carry one hand edit**: `completePhase()`, added so a
finished fan-out can close its phase without waiting for the next phase or the
end of the run.

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
| `src/providers/mcp-provider.ts` | Upstream's own embeddable MCP client (the `createRuntime` package listed in upstream `package.json`); replaced by `mcp/client-hub.ts`, which is written here against `@modelcontextprotocol/client`. **Upstream's package is deliberately not a dependency of this repo.** |
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
| `execution-service.ts` | Trimmed: no Node-process runtime, no schema-enforce branches, no `agents.handoff` deferral, no `authorizer` plumbing. Upstream's `$models` case dropped. **All `spindle.$*` host-call cases live in the `host-calls.ts` table**, not here: the service builds one `HostCallContext` per execution and dispatches through `hostCallTable`. The six discovery entries (`spindle.$providers` / `$catalog` / `$list` / `$search` / `$describe` / `$call`) are spindle-local, not upstream, and back the guest `tools` namespace (see `runtime/guest-host-refs.test.ts` for the contract). `spindle.$timer` is satisfied inside `runtime/quickjs-runtime.ts` and never reaches this switch. `spindle.$progress` currently has no guest producer (host-side `context.update` drives progress instead) but is kept callable. `guardAgentCall` guards the launching refs only (`isAgentBudgetRef`: `agents.run` / `agents.runAll` / `agents.start`; waiting, listing and cancelling are free). The orchestration deadline is `max(executor.timeoutMs, agents.timeoutMs) + BLOCKING_HOST_CALL_SLACK_MS`, and a blocking agent ref extends it by the same slack, so an agent call always reports its own outcome instead of the sandbox killing the program that waits for it. The type-check failure path reports the first errors verbatim (activity + trace message), and the emitted source map is forwarded to the runtime so guest stack positions map back to the program. Added a local `UsageWithReasoning` type because the installed `@earendil-works/pi-ai` `Usage` has no `reasoning` field. |
| `spindle-exec-tool.ts` | Tool renamed to `spindle_exec`; `label` is `Spindle`. `description`, `promptSnippet` and the `code` parameter description rewritten for the surviving namespaces. `tokenBudget` parameter and the prewalk handoff block removed; `agentBudget` kept (maps to `maxAgentCalls`). `renderCall` gained the `π` payload block and `renderResult` was split (its body moved to a local `renderResultBody`, so the `τ` block can be appended to whichever of its five branches ran without threading a wrapper through every `return`); both delegate to `ui/inspect-preview.ts`. The bodies are otherwise unchanged, except type-check failures: `details.typeErrors` (persisted via `audit/details.ts`) renders as one red `Line L:C: message` row per error with an expand hint, so the TUI shows why the program never ran instead of a bare failure. Exported factory is `createSpindleExecTool`. |
| `config.ts` | Trimmed: removed `mesh`, `memory`, `schema`, `compaction`, `retention`, `mcp` (upstream's own MCP client block) and `prewalk`. `executor.runtime` narrowed to the literal `"quickjs"`. `agents` repurposed to `{ maxPerExecution, timeoutMs, waitMs, defaultModel?, defaultThinking? }` (`timeoutMs` caps a child's lifetime, `waitMs` caps how long a caller blocks before the run detaches). `capture.keepVisible` default is `["spindle_exec"]`. **Config file renamed to `spindle.json`** (`<agentDir>/spindle.json`, `<cwd>/.pi/spindle.json`) so spindle never reads or writes pi-fabric's user config; the env override is `PI_SPINDLE_FULL_CODE_MODE`. Upstream's compaction-engine env side effect is gone. |
| `config-migrations.ts` | Untouched. Its legacy `subagents` → `agents` migration is inert for a fresh `spindle.json`; it still provides the `configVersion` guard. |
| `runtime/quickjs-runtime.ts` | `GUEST_SETUP` trimmed: removed `globalThis.{mesh,memory,state,schema,compact,council,rlm,agent,budget}`, `__createActor`, `__handoff`, `__handoffFacts`/`__successfulCalls`, `__workflowAgent`, `__budgetedRun`, `__recordAgentUsage`, `__workflowBudgetTotal`/`__workflowSpentTokens`, `workflow.agent`, `workflow.budget`. **A local `tools` global was added back** (discovery + generic dispatch, upstream's `__toolsBase` shape is gone; core-tool names raise an actionable error pointing at `pi.<name>`). `globalThis.agents` is `{ list, run, runAll, start, wait, status, cancel }` (string sugar: `agents.wait('runId')`, `agents.cancel('runId')`). `globalThis.mcp` is a frozen `{ call, list, search, describe, connect }` over the unprefixed `mcp.*` refs. The nested `mcp.<server>.<tool>` Proxy sugar was removed (483 recorded `mcp.call` uses vs 6 for the sugar); the qualified form survives only as a ref for `tools.call`. Dropping the sugar is what freed the sigil: the `$` existed only so management actions could not collide with a server name in the ref space. `SpindleSandboxOptions.tokenBudget` and the token-budget guest global removed. Setup eval filename is `spindle-setup.js`. Local additions beyond the trim: the frozen `process` shim (injected via `options.process`), `pi.bash` extras (`cwd` / `env` / `stdin`, alias-normalized in `__piArgAliases`), `spindle.$timer` host-call short-circuit, and source-mapped error reporting: the transpiled program carries a source map (`options.sourceMap` or the self-transpiled one) and guest stack positions are rewritten to `program.ts:line:column` via `runtime/source-map.ts`; dumped guest errors render as `Name: message` + frames instead of a JSON blob. |
| `runtime/guest-types.ts` | Trimmed to match `GUEST_SETUP` exactly. Removed every interface for dropped subsystems. Upstream's agents API interface replaced with spindle's run-book contract (`list` / `run` / `runAll` / `start` / `wait` / `status` / `cancel`) plus `SpindleAgentDefinition` / `SpindleAgentRequest` / `SpindleAgentResult` / `SpindleAgentHandle` / `SpindleAgentWait` / `SpindleAgentStatus`. Upstream's MCP API interface replaced with the bridge surface plus the Proxy sugar index signature. `FULL_CODE_GLOBAL_DECLARATIONS` gating for `pi` / `extensions` kept verbatim. Local additions beyond the trim: the `tools` (`SpindleToolsApi`) declaration, the `process` shim declaration, `SpindleBashOptions` (`cwd` / `env` / `stdin` + `workdir` aliases) on `pi.bash`, and `type-checker.ts` importing these declarations in its own tests. |
| `runtime/orchestration.ts` | `BLOCKING_ORCHESTRATION_REFS` and the static-detection regex cover `agents.run` / `agents.runAll` / `agents.wait`; `AGENT_BUDGET_REFS` (`isAgentBudgetRef`) is the separate set that consumes the per-execution agent budget. `requestedBlockingTimeoutMs` reads `max(waitMs, timeoutMs)` for those refs. |
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

The subagent sandbox floor (`sandbox/agent-floor.ts`) is a separate system and
is untouched. The `"approve"` member was also removed
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
| `providers/mcp-client-provider.ts` | `mcp.*` → `mcp/client-hub.ts`. **Upstream has a file with the same provider name (`mcp`) that is deliberately not vendored; this one is written here.** |
| `providers/agents-provider.ts` | `agents.*` → the absorbed subagents code. `#launch` is the pipeline (`#resolveRequests` → start monitor → own `AbortController` → invoke the run launcher → register in the run book); every action then either waits on the book or queries it. **Upstream also ships `src/providers/agents-provider.ts`, fronting its own RLM/handoff agent runtime; that file is NOT vendored, and this file is unrelated to it.** |
| `providers/agent-run-book.ts` | New. The live book of batches: bounded waits, detachment, the completion sink, and cancellation (see "Run lifetime and cancellation"). |
| `providers/agent-run-monitor.ts` | The widget-facing projection: `SpindleAgentRunRegistry` (the widget's data source) and `RunProgressMonitor`, which turns backend status updates into registry rows + the one-line ticker behind a `start`/`onStatus`/`stop` interface. |
| `ui/transcript-types.ts` | `SpindleLogLine`, copied from upstream `src/agents/types.ts`, so the transcript parser does not import a dropped subsystem. |
| `agents/` | The absorbed `extensions/subagents` code (see below). |
| `providers/spindle-bash-tool.ts` | Spindle's `pi.bash` definition: wraps pi's bash tool with per-call `cwd` / `env` / `stdin` extras (validated, then applied via per-call `BashOperations`); extras-free calls delegate to the base tool unchanged. The `stdin` path delegates to the shared supervised spawn (`sandbox/supervised-spawn.ts`) and routes through the OS-sandbox wrap. |
| `env-snapshot.ts` | The allowlisted environment snapshot injected as the guest's `process` global; secrets never enter the sandbox. |
| `session-store.ts` | The session-scoped JSON scratchpad behind the guest's `τ` namespace: key validation, per-value/total byte budgets, the held-key listing the result envelope echoes, and the `describe()` summary a limit error names. Owned by `SpindleState`, so it outlives one program; throws rather than evicting. |
| `ui/inspect-preview.ts` | Two things the rendered call was hiding. The `π` block: `payloads` is where a program is told to put every awkward value, and the code preview then shows `π.body` with no way to see what `body` is (the sole exception being a payload bound to a `pi.write`, which the write preview renders while composing, and which the block therefore skips). Collapsed it is one dim summary line; expanded, a bold `π.key` header per payload with bounded content. And the τ helpers: `readSpindleStateNotes` / `applySpindleStateNotes` put each operation's value into its own trace row. A local module because `ui/spindle-render.ts` is in the render parity set. |
| `ui/inspect-preview.test.ts` | Line-level tests over a pass-through theme: collapsed summaries, expanded bounds and elision counts, header separation, write-preview de-duplication, τ note parsing and in-order application, and that a reloaded transcript (no notes) leaves its rows untouched. |
| `session-store.test.ts` | Round-tripping, snapshot semantics (a stored value is not a live reference), miss vs stored `null`, refused values (undefined, functions, cycles), key validation, and that each limit throws and names what is held. |
| `core/arg-redaction.ts` | Redacts `pi.bash` `env` values and `stdin` from recorded surfaces (audits, previews, traces); the live call keeps raw values. |
| `runtime/source-map.ts` | Minimal source-map consumer: decodes the transpile map and rewrites `pi-spindle-guest.js:L:C` stack positions to `program.ts:L:C` in the program the model wrote. |
| `runtime/checker-backend.ts` | The type-checker backend seam: `check` / `transpile` behind one interface, with the stock `typescript` backend as default and runtime-installable alternatives (e.g. a native-compiler process) without touching the checker core. |
| `host-calls.ts` | The host half of the guest/host call contract: one `HOST_CALLS` table entry per `spindle.$*` ref (discovery, workflow, spans, `τ` state), each owning its handler over a per-execution `HostCallContext`. The execution service dispatches through `hostCallTable` and holds no host-call cases of its own; `runtime/guest-host-refs.test.ts` drives the table from the guest side. |
| `runtime/guest-host-refs.test.ts` | The guest/host ref contract: runs a probe program through a real sandbox with a recording bridge, asserts every emitted ref is handled and every static `spindle.$*` table entry is reachable, and that no `fabric.$` names survive a port. |
| `execution-service.test.ts` | Headless execution-service tests over a stub-provider registry: type errors, extension calls, discovery dispatch, phases, agent budget, and source-mapped runtime errors. |
| `runtime/quickjs-runtime.test.ts` | Runtime integration tests: host-call marshalling and rejection, concurrency, logs and truncation, deadline, abort (pre-start and mid-host-call), memory limit, timers, `π` strings, `process` shim, and error-position mapping. |
| `runtime/guest-polyfills.ts` | The host APIs the engine does not ship, as guest source: `TextEncoder`/`TextDecoder`, `URL`/`URLSearchParams`, `atob`/`btoa`, `structuredClone`, `crypto`, `queueMicrotask`, `performance`, `AbortController`, and the loud-failure guard for the absent `Intl`/`Atomics`. Each polyfill declares the identifiers that imply it and is injected only when the program text mentions one, because `newContext()` runs per `execute()` call and every byte would otherwise be re-parsed on every invocation. Deliberately no `fetch`, `crypto.subtle` or `WebAssembly`: those are capabilities, and the audited host-call table has to stay the only route out. Must be kept in step with the declarations in `runtime/guest-types.ts`, since these globals are not in `lib.es2025` and TS2304 is not filtered. |
| `runtime/guest-baseline.test.ts` | Locks the engine baseline. The pinned variant is bellard/quickjs `2025-09-13+f1139494` (`@jitl/quickjs-singlefile-mjs-release-sync@0.32.0`: release, sync, singlefile), whose global surface is not covered by the package's semver, so a `quickjs-emscripten-core` bump can add or remove intrinsics silently. Pins `globalThis`, asserts the ES2024/ES2025 features the engine does implement, and asserts the absences the polyfill layer covers. |
| `runtime/engine-lib.test.ts` | Guards the type-checker `lib` tier against that baseline from both sides: the ES2025 APIs the engine has must resolve to real signatures, and the ones it lacks (`Array.fromAsync`, `JSON.rawJSON`) must stay untyped so the tier cannot creep to `esnext`. Discriminates on arity (TS2554, unfiltered) rather than property existence, because TS2339 is filtered and so cannot tell "typed" from `any`. |
| `runtime/guest-polyfills.test.ts` | Behavioural tests for the polyfill layer, plus the conditional-injection contract (a program that mentions nothing gets nothing). |
| `runtime/guest-abort.test.ts` | Cancellation end to end: the `AbortController` shape, that a signal never reaches a tool's argument schema, that aborting one call really aborts the host work and leaves its siblings running, and that `mapLimit` stops launching items. |
| `runtime/guest-intl.test.ts` | That the absent locale APIs fail loudly: `Intl`/`Atomics` name the missing property, a locale argument to `toLocaleString` throws instead of being ignored, and the same methods still work without one. |
| `sandbox/policy.ts` | Pure filesystem policy: modes, writable roots, deny patterns, and the config object `@anthropic-ai/sandbox-runtime` expects. |
| `sandbox/manager.ts` | Runtime plumbing: loading `srt`, initializing it for a policy, and the late-bound `bash` operations (supervised by `sandbox/supervised-spawn.ts`). |
| `sandbox/supervised-spawn.ts` | The one supervised process-tree spawn: detached process group, kill-tree on timeout/abort, stdin piping, and the `timeout:<seconds>` / `aborted` error contract, behind one small interface. Two adapters ride on it: the OS-sandbox wrap (`sandbox/manager.ts`) and the `pi.bash` stdin extras (`providers/spindle-bash-tool.ts`), which previously carried two private copies of these mechanics. |
| `sandbox/controller.ts` | The session's live sandbox state. Hands out stable operations whose closures read the *current* policy, so the mode can change mid-session. `readGuard()` hands out the same shape of stable closure for the denyRead roots. |
| `sandbox/protocol.ts` | Bus contract for changing the mode at runtime (`spindle:sandbox-request` / `spindle:sandbox-state`). |
| `sandbox/night-bridge.ts` | Reads the night-mode handshake, so a subagent process inherits the run's policy without any IPC. Gated on participation, so a bystander session does not. |
| `sandbox/resolve.ts` | Precedence: config, request, and the floor an active night run imposes. Pure. |
| `mcp/read-only-policy.ts` | Read-only MCP guardrail: the declarative `mcp` config block, the built-in per-server profiles (slack, linear, datadog, metabase), the name-shape classifier, and `McpReadOnlyGate`, which owns the allow/deny decision for both dispatch points. Pure. |
| `mcp/server-config.ts` | `mcp.json` loader for spindle's own client. Field-compatible with pi-mcp-adapter (same `mcpServers` schema, same `includeTools`/`excludeTools` glob rules, same `mcp_<server>_<tool>` prefix), layered agent → `.pi/mcp.json` → `.mcp.json`, credentials URL-bound on merge. Pure. |
| `mcp/token-store.ts` | OAuth credential storage. Same credential-store service and `sha256-<sha256(serverName)>` account as pi-mcp-adapter, so switching clients needs no re-auth, but a record is always **one** item: reading one of the adapter's chunked records compacts it, which is what ends the per-item macOS keychain prompt storm (the adapter chunks at 1000 chars for the Windows blob cap, turning one server into six keychain items with six ACLs). |
| `mcp/oauth-provider.ts` | `OAuthClientProvider` over `token-store.ts`. Headless refresh works; anything needing a browser throws `McpAuthorizationRequiredError` unless a `redirect` handler is supplied, so a tool call never tries to open one. |
| `mcp/tool-cache.ts` | Tool schemas persisted to `<agentDir>/spindle-mcp-tools.json`, keyed by endpoint + config fingerprint. This is what lets `mcp.list` / `search` / `describe` answer without connecting, so `describe` returns a real input schema instead of the bridge's permissive stub, and discovery cannot trigger an OAuth prompt. |
| `mcp/client-hub.ts` | The MCP client itself: lazy per-server connect over streamable HTTP (stdio supported, unix socket reported as unsupported), tool filtering, name resolution for `server.tool` / `mcp_server_tool` / bare names, and `callTool`. |
| `mcp/auth-flow.ts` | The `/mcp-auth` browser leg: loopback callback server on a fixed port, the two `auth()` legs, state validation, and dropping a client registered against another redirect URI. **The only module that may open a consent screen**, and it is reachable only from the slash command. |
| `mcp/status-report.ts` | Text for `/mcp status` and `/mcp tools`. Pure, so the formatting is tested without a session. |
| `providers/mcp-client-provider.ts` | `mcp.*` on the hub. Same five management actions, same `mcp.<server>.<tool>` refs, same `{ text, content, structuredContent }` shape and same `McpReadOnlyGate` as the bridge, so a program cannot tell which one it is talking to. |
| `mcp/night-bridge.ts` | Reads `mcp.readOnly` from the night-mode handshake, so a subagent process inherits the guardrail with no IPC. Participation-gated, like `sandbox/night-bridge.ts`. |

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

The handshake file is global, so reading it is gated on **participation**
(`isNightRunParticipant`, night-mode). A session the user opens at 2am while a run
is in flight is a bystander and keeps whatever `spindle.json` configures. Three
ways to qualify:

| Signal | Covers |
|---|---|
| `PI_NIGHT_RUN=1` in the environment | children spawned by the headless backend (`agents/headless.ts`) |
| `sessionId` matches the run's | the coordinator session that ran `/night start` |
| cwd inside the run's clone or `<clone>.agents/...` | children the spawn path cannot hand an environment to (herdr panes) |

A run started with cloning disabled (`sandboxRoot: ""`) has no clone to key on, so
herdr-launched children of such a run fall back to bystanders. The coordinator is
still enforced through the bus.

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
it has to write.

Egress is the one place a night run **widens** instead of tightening: its
`network.allowedDomains` are unioned into the configured allowlist (a config of
`["*"]` is already unrestricted and is left alone). The reason is the failure
mode, not convenience: a narrowed allowlist breaks an unattended run at 3am with
nobody awake to widen it, and reaching a forge is not the destructive path this
guardrail exists for. `deniedDomains` stays config-only and the runtime checks
denials first, so `deniedDomains: ["github.com"]` is still an absolute kill
switch. A `/sandbox` request carries no network at all. A refused request is surfaced as a warning rather than silently
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
tool). `SessionRef` and the `buildRunRequests`
orchestration were salvaged into `providers/agents-provider.ts`; the ticker and
`PROGRESS_TICK_MS` into `RunProgressMonitor` (`providers/agent-run-monitor.ts`);
the throttled `cleanupOldRuns()` sweep into `index.ts`.

`agents/pi-args.ts`'s `childExtensionPath()` resolves `child-extension.ts`
relative to `import.meta.url`, so it keeps working after the move with no edit —
`agents/pi-args.test.ts` asserts this. (Formerly `result-tool.ts`, which hosted
a `submit_result` tool; that tool was removed in favor of reading the child's
final assistant message, and the file was trimmed to just registering the
sandbox-mode flag.)

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
- calls `renderProgress(...)` once per tick, flattened to a single line (prefixed
  by an optional `note`, e.g. the run launcher's fallback reason when a drifted
  herdr CLI degraded the batch to headless), as the
  `context.update(...)` body, so `ui/spindle-render.ts`'s
  `singleCallProgressLine` / `renderNestedAgentToolLines` /
  `renderSpindleMulticallPartial` render the in-flight ticker;
- (the provider) returns a structured `SpindleAgentResult` so `ui/structured.ts`'s
  `formatSpindleValue` formats it, instead of the old hand-rolled markdown.

`SpindleAgentRun.runId` is set to `context.parentToolCallId`, which is also the
`SpindleActivityRun.id`, so the widget can associate rows with the running program.

### Subagent sandboxing

A subagent used to be bounded by its `tools:` frontmatter: the parent filtered
pi's `--tools`, forwarded the declared list on `--spindle-allowed-tools`, and a
`SpindleToolGate` in the child removed the rest from the `pi.*` / `extensions.*`
schema. That took the capability away without taking the danger away. A
librarian denied `bash` found out by failing mid-task (`Tool pi.bash is not in
this agent's tool allowlist`), then rerouted through weaker tools and burned
turns doing it, while still being free to write anywhere it could reach.

That whole system is gone (`core/tool-allowlist.ts`, its flag, the gate
threading through the providers and the execution service, the `PiToolsApi`
schema surgery in `runtime/guest-types.ts`, and the `tools:` field itself). A
subagent keeps the parent's full toolset and is bounded by the filesystem
sandbox instead:

- an agent definition declares `sandbox: read-only` (any `SandboxMode`;
  `agents/frontmatter.ts` drops an unrecognised value rather than failing the
  launch);
- `agents/pi-args.ts` forwards it on `--${SANDBOX_MODE_FLAG}`
  (`--spindle-sandbox`, declared in `agents/constants.ts`) and loads
  `agents/child-extension.ts` via `--extension` only to register that flag, for
  the same reason the allowlist needed one: pi rejects a flag registered twice,
  and `getFlag` only resolves flags the reading extension registered, so
  Spindle reads raw argv (`core/argv-flag.ts`);
- `sandbox/agent-floor.ts` turns the flag into a `SandboxRequest`, and
  `spindle-state.ts` passes it to `effectiveSandbox` as a **floor** alongside
  the night floor: a `/sandbox` request inside the child can tighten it, never
  loosen it, and the tightest of the two floors wins (`sandbox/resolve.ts`).

Enforcement is the existing one, so there is no second mechanism to keep in
sync: `bash` runs under the OS sandbox (Seatbelt/bubblewrap via
`@anthropic-ai/sandbox-runtime`), `write`/`edit` are path-checked, and the read
tools honour `denyRead`.

What this does not do: `read-only` still grants the temp dirs (a compiler that
cannot write a temp file is a brick, not a sandbox) and leaves egress
unrestricted, so it bounds damage rather than visibility. It also refuses tools
that write outside temp, including `jj` without `--ignore-working-copy` (it
snapshots the working copy) and anything writing a build cache, since
`read-only`'s writable set is temp only, not the cache roots `workspace-write`
grants.

### Run lifetime and cancellation

A subagent run used to be tied to the `spindle_exec` program that started it,
with a single 30-minute deadline on both sides. Two failure modes came out of
that: a long run was killed as `Execution timed out` with its result discarded,
and a cancelled parent left its children running. Three pieces fix it.

**Bounded waits (`providers/agent-run-book.ts`).** Every launch is registered in
`AgentRunBook`, keyed by the batch `runId`. `agents.run` / `agents.runAll` /
`agents.wait` block for `waitMs` only; an expired window is a normal outcome that
returns `state: "running"` plus the `runId`, and marks the batch **detached**.
The deadlines are now independent: `waitMs` bounds the caller, `timeoutMs` bounds
the child, and `execution-service.ts` keeps the sandbox deadline one
`BLOCKING_HOST_CALL_SLACK_MS` past every agent deadline it can wait on
(`executor.timeoutMs`, `agents.timeoutMs`, `agents.waitMs`, and any explicitly
requested `waitMs`/`timeoutMs`), so the inner call always reports first.

**Unclaimed results are announced.** A batch that settles with nobody attached
(after `ANNOUNCE_DELAY_MS`, so a waiter mid-race still claims it) goes to the
completion sink. `spindle-state.ts` binds that sink to
`pi.sendMessage({ customType: "spindle.agent_result" }, { deliverAs: "followUp",
triggerTurn: true })`, so a background run wakes the parent with its result
instead of requiring a poll. A cancelled batch is never announced.

**Cancellation reaches the children.** Each batch owns an `AbortController`. An
attached launch links the invocation signal into it (cancelling the turn kills
the children); the link is dropped on detach so the end of a turn does not kill a
background run. `SpindleState.shutdown()` resets the book, cancelling everything
still live. The abort then has to actually land:

- headless (`agents/headless.ts` + `agents/process-tree.ts`): children are
  spawned `detached: true` and torn down group-wide, SIGTERM (so the child can
  flush its transcript) then SIGKILL after `DEFAULT_KILL_GRACE_MS`. Signalling
  only the direct `pi` process left its own bash/test/migration subprocesses
  running against the working copy.
- herdr (`agents/herdr-backend.ts`): aborting used to tear down only the local
  waits, leaving the panes alive. The batch now closes its tab on abort (and in a
  `finally`), which removes every pane and the `pi` processes inside them.

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
  `backend.ts` owns the **run launcher** (`RunLauncher`), the deep module that picks the adapter by environment *and* contains herdr CLI drift: it probes the installed herdr for the dialect the adapter speaks (`agent start --kind`, `agent wait`) at most once per process, and falls back to the headless adapter with a surfaced reason when the binary has drifted, instead of failing every run.
  `RunResult` is a discriminated union on `backend` (`"headless"` carries
  `exitCode`, `"herdr"` carries `paneId`) so backend-specific diagnostics do not
  leak as bare optionals into the shared type; `run.ts`'s `baseResult` builds the
  shared fields both adapters populate.
- **run context** (`RunContext`): the ambient inputs a backend needs for a batch
  (session id/file, runId, cwd, timeout, abort signal, status callback). The
  signal is the *batch's* own `AbortController`, not the invocation signal, so a
  batch can outlive the program that launched it (see "Run lifetime and
  cancellation").
- **wait window** (`waitMs`): how long a caller blocks on a batch. Distinct from
  the batch's `timeoutMs`, which is how long its children may live.
- **detached batch**: a live batch nobody is blocked on. Its result is announced
  through the completion sink instead of being returned to a caller.
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

## MCP client contract

`mcp.*` is served in-process. `providers/mcp-client-provider.ts` holds the five
management actions and the `mcp.<server>.<tool>` ref form; `mcp/client-hub.ts`
owns the `@modelcontextprotocol/client` connections, one per configured server,
opened on first use.

| Spindle action | Sandbox call | Hub call |
|---|---|---|
| `mcp.call` | `mcp.call(server, tool, args)` / `mcp.call({ server?, tool, args? })` | `callTool(tool, args, ctx, server?)` |
| `mcp.list` | `mcp.list(server)` / `mcp.list({ server? })` | `status(server?)`, config + cache only |
| `mcp.search` | `mcp.search({ query, server?, regex?, includeSchemas? })` | `searchTools(query, opts)`, cache only |
| `mcp.describe` | `mcp.describe({ tool, server? })` | `describeTool(ref, server?)`, cache only |
| `mcp.connect` | `mcp.connect(server)` | `connect(server)`, reconnect + refresh schemas |

Four invariants:

1. **Fail at use, never at startup.** The hub is constructed on the first
   `mcp.*` call and its constructor touches nothing: no config read, no
   credential-store read, no connection. A session with no MCP program pays
   nothing, and a broken `mcp.json` layer is reported as an error string on
   `mcp.list` rather than killing the session.
2. **No pre-fetch.** `list`, `search` and `describe` answer from
   `mcp/tool-cache.ts` and never connect. A server whose tools have never been
   listed simply contributes nothing until `mcp.connect` or a call warms it.
   This is also what makes guest type generation safe (`runtime/dynamic-guest-types.ts`
   reads the same cache).
3. **Authorization is the user's, never the tool's.** A refresh-token grant runs
   headless. Anything that would need a consent screen throws
   `McpAuthorizationRequiredError`, whose message tells the model to stop and ask
   the user to run `/mcp-auth <server>`. The consent screen needs an `onRedirect`
   handler, and `mcp/auth-flow.ts` is the only caller that supplies one, so an
   unattended authorization is impossible by construction rather than by
   convention: `client-hub.ts` has no way to pass it.
4. **One credential-store item per server.** `mcp/token-store.ts` writes a
   record as a single item and compacts a chunked pi-mcp-adapter record on read.
   The adapter chunks anything over 1280 chars into 1000-char items for the
   Windows Credential Manager blob cap, which on macOS means one server becomes
   six keychain items, six ACLs and six prompts.

Results are normalized to `{ text, content, structuredContent }`, and an
`isError` result is rethrown with its text so a failed tool call rejects instead
of returning quietly.

### `/mcp` and `/mcp-auth`

Both commands came from pi-mcp-adapter before; with the in-tree client they are
registered in `index.ts` and share the session's hub through
`SpindleState.mcpClient(cwd)`, so a status read shows the connections this
session really holds and an authorization is visible to `mcp.*` with no reload.

| Command | Effect |
|---|---|
| `/mcp` (or `/mcp status`) | Servers, states, tool counts (marked `cached` when they came from disk), targets, and any `mcp.json` parse errors |
| `/mcp tools [server]` | Cached tools per server; names the `connect` command when a server has none |
| `/mcp connect <server>` | Connect (or reconnect) and refresh the schema cache |
| `/mcp logout <server>` | Clear that server's credential-store record |
| `/mcp-auth <server>` | Authorize in a browser, then connect to prove the token works and warm the cache |

`/mcp-auth` uses a FIXED loopback port (33418 by default, `oauth.redirectPort`
per server, or `SPINDLE_MCP_REDIRECT_PORT`) rather than an ephemeral one: a
dynamically registered OAuth client is bound to the exact `redirect_uri` it
registered with, so an ephemeral port would force a fresh client registration on
every authorization. A stored client registered against a different redirect URI
is dropped up front (tokens are kept, since a refresh may still work), because
the authorization server would reject it.

`mcp.json` compatibility is deliberate and load-bearing: the same file, the same
`mcpServers` schema, the same `includeTools` / `excludeTools` glob rules, the
same `mcp_<server>_<tool>` prefix the read-only policy keys off, and the same
credential-store service and account as pi-mcp-adapter, so switching between the
two needs no config edit and no re-authentication. Entries the client cannot run
(`socket`, `requestHeadersCommand`) are surfaced by `mcp.list` as
`state: "unsupported"` with a reason instead of being dropped.

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
   npm run fmt -- extensions/spindle/<local path>
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

6. Verify: `npm run typecheck`, `npm test` and `npm run fmt:check` must all exit
   0, plus the rename invariants:

   ```sh
   fd fabric extensions/spindle skills          # must be empty
   rg -i fabric extensions/spindle skills -g '!CONTEXT.md' -g '!guest-host-refs.test.ts'   # must be empty
   rg 'fabric\.\$' extensions/spindle -g '!guest-host-refs.test.ts'   # must be empty
   ```

   (`runtime/guest-host-refs.test.ts` names `fabric.$` on purpose: it is the
   assertion that guards the rename, so the exclusions above keep the recipe
   exact.)
