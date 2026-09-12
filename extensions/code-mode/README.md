# Code mode

`code_mode` executes type-checked TypeScript in QuickJS. Read the bundled [skill](../../skills/code-mode/SKILL.md) for tool signatures, payloads, batching, state, and error recovery.

## Migration from Spindle

- Load `extensions/code-mode/index.ts` instead of `extensions/spindle/index.ts` if using an explicit extension path. Package discovery picks up the renamed directory automatically.
- Use `code_mode`, not `spindle_exec`. There is no model-facing compatibility alias. The skill is now `code-mode`.
- Use `web.search` and `web.fetch` instead of `extensions.web_search` and `extensions.fetch_content`. No generic `extensions.*` namespace or raw-name fallback remains.
- Existing `~/.pi/agent/spindle.json` and trusted project `.pi/spindle.json` configuration paths remain canonical for compatibility. Legacy `spindle_exec` entries in `capture.keepVisible` normalize to `code_mode`.
- Existing transcript, event, child-process flag, and sandbox protocol identifiers retain their historical names. Internal `Spindle` types are not additional model tools.
- Reload Pi after updating. Update any manually configured extension or skill paths outside this package.

## Tool exposure and permissions

In full code mode, Pi core tools are called through `pi.*`. The host explicitly maps the web extension's `web_search` and `fetch_content` callbacks to `web.search` and `web.fetch`. Unrelated sibling tools keep their native tool paths rather than being hidden or implicitly exposed through a catch-all namespace.

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
