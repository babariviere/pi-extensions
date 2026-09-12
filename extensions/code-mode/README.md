# Code Mode

`code_mode` executes type-checked TypeScript in QuickJS. Read the bundled [skill](../../skills/code-mode/SKILL.md) for tool signatures, payloads, batching, state, and error recovery.

## Configuration and identifiers

- Explicit extension paths use `extensions/code-mode/index.ts`; the model-facing tool and bundled skill are `code_mode` and `code-mode`.
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
