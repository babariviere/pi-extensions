# pi-extensions

Personal extensions and themes for [pi](https://github.com/earendil-works/pi).
This remains a collection of pi integrations, not a bundle of a separate application.

## What is packaged

The manifest discovers `extensions/*/index.ts` and `themes/*.json`.

| Extension | Purpose |
| --- | --- |
| `apply-patch` | Standalone `applyPatch` V4A file-editing tool, available directly and through native codemode. |
| `ask` | `--ask` selects the cheapest priced scoped model and disables thinking for a one-shot question. |
| `clef` | Local Clef Flash MLX classifier (optional full model), offline startup checks and lazy loading with idle unloading; `/clef install` prepares Python/model dependencies, `/clef` shows status. |
| `context` | `/context` shows loaded resources, project context, tokens and cost. |
| `footer` | Project, context, model, thinking, subscription usage and extension status. |
| `guardrail` | `/guardrail` controls checks for obvious catastrophic shell commands and direct shell-edit patterns. |
| `jobs` | Native `jobs_*` tools manage session-owned background shell jobs through the sandbox extension. |
| `linear` | `/linear` lists current-sprint issues or starts work on a ticket. |
| `night-mode` | `/night` runs approved overnight tasks with a ledger, usage guards, reports, optional private working copies and wake locks. Native `night_plan` reviews the plan. |
| `pr` | `/review-comments`, `/autofix`, and `/autofix-stop` integrate GitHub reviews and CI. |
| `router` | Opt-in `router/auto` virtual model with scoped, authenticated, cost-aware physical routing. |
| `preview-system-prompt` | `/system-prompt` shows the assembled prompt. |
| `sandbox` | `/sandbox` controls filesystem policy and native MCP read-only permissions for direct and codemode-nested calls. |
| `secrets` | `/secret-list`; fnox shell injection and reversible secret references in text, structured results and persisted details. |
| `subagents` | One native `subagent` tool manages named persistent background conversations, automatic answers, steering, stop and durable recovery. |
| `todos` | Native `todo_*` tools manage file-backed todos; `/todos` provides the interactive manager. |
| `tool-substitute` | Search guidance and jj-aware Git-write checks. |
| `usage` | `/usage` polls Claude and Codex/ChatGPT subscription windows. |
| `web` | `web_search` searches Kagi; `fetch_content` fetches pages or summarizes Git repositories; `/kagi-status` checks credentials. |
| `workspaces` | `/workspace` manages jj workspaces, with optional Herdr integration. |

Themes include Catppuccin Frappé, Latte and Macchiato, plus Rosé Pine Dawn and Moon.

## Install and update

```sh
pi install git:github.com/babariviere/pi-extensions
pi update --extensions
```

For a local checkout, run `pi install ./`. Individual extension paths can also be
loaded through pi's normal configuration.

Requires Node.js `>=24.0.0` and pi `>=1.0.0`. The host supplies
`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`
and `typebox` as peer dependencies. This package no longer installs its own
native Pi SDK, MCP SDK or keyring implementation.

Subagents use bundled, pinned pi-durable and Chord libraries for persistent
conversations and checkpointed tasks. Pi-durable owns the child model loop;
isolated native Pi kernels preserve tools and policy. There is no optional legacy
backend. See [Subagents](extensions/subagents/README.md).

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

Other capabilities include `tools.night_plan`, `tools.subagent`, `tools.jobs_start`,
`tools.applyPatch`, and `tools.web_search`. Use native `searchTools()` and
`describeTool()` for exact schemas and tools omitted from the inline catalog.
Less frequently used extension actions use deferred exposure and remain callable
by name or discoverable with `searchTools()`. Read namespace workflow instructions
with `describeNamespace("todo")` or `describeNamespace("jobs")` when needed;
use `describeTool("subagent")` for the single persistent-conversation tool.
There are no old `pi.*`, `web.*`, `mcp.*`, `agents.*`, `jobs.*`, `π` or `τ` globals.
Use `store()`/`load()` for branch-aware state. Native core reads retain their
ordinary truncation limits; read large files in slices.

### Persistent subagents (breaking change)

The exact API is `subagent({ action: "spawn" | "send" | "stop" | "status", name?, message?, followUp? })`:

```js
await tools.subagent({ action: "spawn", name: "review", message: "Review the changes without editing files." });
return await tools.subagent({ action: "status", name: "review" });
```

Names identify conversations, not Markdown personas. `send` steers by default;
`followUp: true` queues. `stop` aborts current/queued work but retains the
conversation. Answers arrive automatically; named status exposes the latest
completed `lastAnswer: { id, text }` non-destructively, while all-agent status
stays compact. Model/thinking, deadlines and workspaces are host policy.

The old `agents_*` tools, batch/wait handles, per-call `output`, `reads`, `task`,
`model`, `thinking` and night arguments, and automatic Markdown outputs are removed.
Put scope, briefs, permissions and requested deliverables in `message`. Approved
night execution uses its approved `TODO-<id>` as the name; planning children
automatically inherit read-only policy. Old handles cannot map to names: pending
old jobs are safely retired and journals retained, not replayed. See the
[upgrade and recovery caveats](extensions/subagents/README.md).

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
| `~/.pi/agent/subagents.json` and trusted `.pi/subagents.json` | `maxPerExecution`, `timeoutMs`, `defaultModel` and `defaultThinking` host policy. No `waitMs` or backend selection. |
| `~/.pi/agent/router.json` and trusted `.pi/router.json` | Optional cheap, strong and direct physical models for `router/auto`. |
| `~/.pi/agent/clef.json` and trusted `.pi/clef.json` | Local classifier interpreter, checkpoint, idle timeout and memory/input limits. |
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
- Jobs require the sandbox extension, even when policy is off, and stop on shutdown
  or reload. Persistent subagents survive reload; quit pauses them for same-session
  recovery. Explicit stop cancels work but retains the conversation. Native tools
  are replay-unsafe: interrupted calls are not automatically repeated after a crash.
- Subagent answers use at-most-once parent notification; recover lost notifications
  through named status. Private SQLite recovery directories under `subagent-runs/`
  are not outputs, and persistent databases are not deleted by TTL.
- The macOS pmset wake-lock backend changes a persistent sleep setting and may need
  narrowly scoped sudo. A crash can require manual restoration.
- Workspace deletion, todo deletion, file patches, external CLIs and MCP tools have
  real side effects. Review permissions, maintain backups, and limit credentials.

## Pi usage CLI

`pi-usage` scans session files recursively, including child sessions, deduplicates
branched records and uses recorded costs rather than repricing aliases. It includes
assistant and tool-result usage, cache-warming/other usage entries, compaction and
branch summaries. Tool-side costs without model attribution are grouped by tool,
and summary costs without attribution remain explicitly unknown.

Durable subagent token usage stored in child SQLite databases is not automatically
included in native-parent totals or this JSONL scanner, even though it scans native
child session files.

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
CI explicitly tests the minimum Pi 1.0.0 APIs and the current Pi release. The SDK
packages remain host-provided peers, not bundled runtime dependencies.

## Documentation

- [Apply Patch](extensions/apply-patch/README.md)
- [Sandbox](extensions/sandbox/README.md)
- [Subagents](extensions/subagents/README.md)
- [Jobs](extensions/jobs/README.md)
- [Night mode](extensions/night-mode/README.md)
- [Guardrail](extensions/guardrail/README.md)
- [Secrets](extensions/secrets/README.md)
- [Usage](extensions/usage/README.md)
- [Model router](extensions/router/README.md)
- [Local Clef classifier](extensions/clef/README.md)
- [System prompt viewer](extensions/preview-system-prompt/README.md)
- [pi documentation](https://github.com/earendil-works/pi)
