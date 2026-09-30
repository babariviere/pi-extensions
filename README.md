# pi-extensions

Personal extensions, skills, and themes for [pi](https://github.com/earendil-works/pi).
This remains a collection of pi integrations, not a bundle of a separate application.

## What is packaged

The manifest discovers `extensions/*/index.ts`, `skills/`, and `themes/*.json`.

| Extension | Purpose |
| --- | --- |
| `apply-patch` | Standalone `applyPatch` V4A file-editing tool, available directly and through native codemode. |
| `ask` | `--ask` selects the cheapest priced scoped model and disables thinking for a one-shot question. |
| `context` | `/context` shows loaded resources, project context, tokens and cost. |
| `footer` | Project, context, model, thinking, subscription usage and extension status. |
| `guardrail` | `/guardrail` controls checks for obvious catastrophic shell commands and direct shell-edit patterns. |
| `jobs` | Native `jobs_*` tools manage session-owned background shell jobs through the sandbox extension. |
| `linear` | `/linear` lists current-sprint issues or starts work on a ticket. |
| `night-mode` | `/night` runs approved overnight tasks with a ledger, usage guards, reports, optional private working copies and wake locks. Native `night_plan` reviews the plan. |
| `pr` | `/review-comments`, `/autofix`, and `/autofix-stop` integrate GitHub reviews and CI. |
| `preview-system-prompt` | `/system-prompt` shows the assembled prompt. |
| `sandbox` | `/sandbox` controls filesystem policy and native MCP read-only permissions for direct and codemode-nested calls. |
| `secrets` | `/secret-list`; fnox shell injection and reversible secret references in text, structured results and persisted details. |
| `subagents` | Native `agents_*` tools launch markdown-defined child agents with bounded waits, cancellation, progress and completion notifications. |
| `themes` | Theme selection helpers. |
| `todos` | Native `todo_*` tools manage file-backed todos; `/todos` provides the interactive manager. |
| `tool-substitute` | Search guidance and jj-aware Git-write checks. |
| `usage` | `/usage` polls Claude and Codex/ChatGPT subscription windows. |
| `web` | `web_search` searches Kagi; `fetch_content` fetches pages or summarizes Git repositories; `/kagi-status` checks credentials. |
| `workspaces` | `/workspace` manages jj workspaces, with optional Herdr integration. |

The bundled [code-mode skill](skills/code-mode/SKILL.md) describes **native pi codemode**.
Themes include Catppuccin Frappé, Latte and Macchiato, plus Rosé Pine Dawn and Moon.

## Install and update

```sh
pi install git:github.com/babariviere/pi-extensions
pi update --extensions
```

For a local checkout, run `pi install ./`. Individual extension paths can also be
loaded through pi's normal configuration.

Requires Node.js `>=24.0.0` and pi `>=0.99.0`. The host supplies
`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`
and `typebox` as peer dependencies. This package no longer installs its own
execution runtime, MCP SDK or keyring implementation.

Optional integrations need their own tools and credentials, including Kagi,
fnox, Linear, GitHub CLI, jj, Herdr and platform wake-lock facilities.

## Native codemode and MCP

Pi owns `codemode`, `tool_search`, MCP connections, OAuth, discovery, QuickJS
execution, nested tool events, usage accounting and branch-aware script state.
There is no Code Mode extension, custom provider registry, tool interceptor or
legacy execution fallback in this package.

Configure native pi in `settings.json`:

```json
{
  "defaultTools": ["+codemode", "-find", "-grep", "-ls"],
  "codemode": { "mode": "only" }
}
```

`only` hides callable direct tools from the model while keeping them active and
reachable through scripts. Use `on` to keep direct declarations too. Our extensions
do not override codemode. The `apply-patch` extension disables `edit` and `write`
for selected OpenAI models; add `-edit` and `-write` to `defaultTools` to exclude
them for every model. Other tool selections are left alone.

Scripts are JavaScript and use `tools.<name>`, for example:

```js
const todos = await tools.todo_list({});
const page = await tools.fetch_content({ url: "https://example.com" });
return { tasks: todos.length, page: page.text.slice(0, 1000) };
```

Other capabilities include `tools.night_plan`, `tools.agents_run`, `tools.jobs_start`,
`tools.applyPatch`, and `tools.web_search`. Use native `searchTools()` and
`describeTool()` for exact schemas and tools omitted from the inline catalog.
There are no old `pi.*`, `web.*`, `mcp.*`, `agents.*`, `jobs.*`, `π` or `τ` globals.
Use `store()`/`load()` for branch-aware state. Native core reads retain their
ordinary truncation limits; read large files in slices.

### Migration from our Code Mode extension

- Remove explicit `extensions/code-mode/index.ts`, `legacy.ts` or `headless.ts`
  paths. The package discovers the replacement standalone extensions normally.
- Move the old `code-mode.json` `agents` block to `subagents.json`, and its
  `sandbox` fields to the root of `sandbox.json`. Put its MCP permission policy
  under `sandbox.json`'s `mcp` block. Executor, capture, runtime UI and full-code
  mode settings are retired. No runtime fallback remains.
- Native MCP uses `mcpServers` in `~/.pi/agent/mcp.json` and trusted project
  `.pi/mcp.json`. A project entry replaces the same global server, rather than
  merging per field. Native pi does not read root `.mcp.json` files.
- Convert `disabled` to `enabled`, `requestTimeoutMs` to `timeout` seconds,
  `directTools` and include/exclude filters to `exposure`/`toolExposure`, OAuth
  `redirectPort` to `callbackPort`, and `scopes` to a space-separated `scope`.
  Review unsupported legacy fields rather than silently dropping them.
- Keep credentials as environment or whole-command references. Native OAuth uses
  `mcp-auth.json`; old keyring credentials do not automatically transfer. Use
  `/mcp` or `pi mcp login <server>` for explicit sign-in.
- Remove `-builtin:mcp` and `-builtin:codemode` exclusions to use native support.
  SDK sessions must explicitly load `createCodemodeExtension()`,
  `createMcpExtension()` and optionally `createToolSearchExtension()` through their
  resource loader; CLI sessions load these built-ins by default.

## Configuration

| Location | Purpose |
| --- | --- |
| `~/.pi/agent/settings.json` and trusted `.pi/settings.json` | Pi settings, resource paths and night-mode configuration. |
| `~/.pi/agent/mcp.json` and trusted `.pi/mcp.json` | Native MCP servers. Native OAuth uses the agent directory's `mcp-auth.json`. |
| `~/.pi/agent/subagents.json` and trusted `.pi/subagents.json` | Child limits, waits and default model/thinking. |
| `~/.pi/agent/sandbox.json` and trusted `.pi/sandbox.json` | Filesystem and native MCP permission policy. |
| `~/.pi/agent/secrets.json` | Per-machine Kagi/Linear values, not the fnox secrets extension's source. |
| Nearest `fnox.toml` | Source for shell secret injection and reversible references. |
| `~/.pi/agent/night/` | Default night prompts, instructions, reports, archive, todos and sandboxes. |
| `~/.herdr/workspaces` | Default managed jj workspace root. |

Useful controls include `PI_CODING_AGENT_DIR`, `PI_TODO_PATH`, `PI_GUARDRAIL=off`
and `HERDR_SOCKET_PATH`. Child-run and night markers are internal; do not set them casually.

Keep credentials out of this repository. `secrets.json` accepts either
`{"NAME":"value"}` or `{"secrets":{"NAME":"value"}}`. Web and Linear also read the
process environment. The separate `secrets` extension uses fnox, injects names
into shell environments and redacts text, structured results and persisted details.
Pattern masking is defense in depth, not a guarantee against every indirect leak.

## Safety and operational caveats

- Guardrail catches known destructive command shapes, not arbitrary scripts.
- Sandbox is off by default for ordinary sessions. Night runs and sandboxed child
  agents impose floors that cannot be loosened through `/sandbox`.
- Restricted shells and jobs use macOS Seatbelt. They fail closed if enforcement
  cannot start. Networking is unrestricted; this is filesystem accident prevention,
  not isolation from malicious installed extensions.
- Native codemode's QuickJS boundary does not sandbox the tools it calls. Trusted
  extension callbacks run with host permissions. Review the extensions you install.
- Jobs require the sandbox extension, even when policy is off. Detached jobs and
  children are session-owned and stopped on shutdown or reload, not durable queues.
- The macOS pmset wake-lock backend changes a persistent sleep setting and may need
  narrowly scoped sudo. A crash can require manual restoration.
- Workspace deletion, todo deletion, file patches, external CLIs and MCP tools have
  real side effects. Review permissions, maintain backups, and limit credentials.

## Pi usage CLI

`pi-usage` scans session files recursively, including child sessions, deduplicates
branched records and uses recorded assistant costs rather than repricing aliases.

```sh
pi-usage daily
pi-usage monthly --breakdown
pi-usage session --since 2026-09-01
pi-usage daily --timezone Europe/Paris --json
```

From a checkout, use `npm run pi-usage -- daily`. See `pi-usage --help` for filters.

## Development

```sh
npm install
npm run typecheck
npm test
npm run fmt:check
```

`npm run fmt` applies Biome formatting. CI runs `npm ci`, typechecking and tests on Node 24.

## Documentation

- [Apply Patch](extensions/apply-patch/README.md)
- [Sandbox](extensions/sandbox/README.md)
- [Subagents](extensions/subagents/README.md)
- [Jobs](extensions/jobs/README.md)
- [Night mode](extensions/night-mode/README.md)
- [Guardrail](extensions/guardrail/README.md)
- [Secrets](extensions/secrets/README.md)
- [Usage](extensions/usage/README.md)
- [Native codemode skill](skills/code-mode/SKILL.md)
- [pi documentation](https://github.com/earendil-works/pi)
