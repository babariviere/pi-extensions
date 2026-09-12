# pi-extensions

Personal extensions, skills, and themes for [pi](https://github.com/earendil-works/pi).
This repository remains a collection of pi integrations. It is not a bundle or
renaming of any separate private application.

## What is packaged

The package manifest discovers every `extensions/*/index.ts`, the `skills`
directory, and `themes/*.json` files. The current inventory is:

| Extension | User-facing surface and purpose |
| --- | --- |
| `ask` | `--ask` selects the cheapest priced model in the scoped model set and turns thinking off for a one-shot question. |
| `background-agents` | `/background` opens the background-agent dashboard, submits a bug or feature case, or resumes a case through an owner-only Unix socket. |
| `context` | `/context` shows loaded extensions, skills, project context files, and session context-window/token/cost information. |
| `footer` | Replaces the footer with project, context, model, thinking, subscription-usage, and extension-status information. |
| `guardrail` | `/guardrail` shows or toggles a checker for obvious catastrophic `bash`/`exec` commands and direct file-edit patterns. |
| `linear` | `/linear` lists current-sprint issues or fetches a ticket, moves it to In Progress, and starts `/feature`. |
| `night-mode` | `/night` runs scheduled overnight planning/orchestration with a todo ledger, usage guards, reports, optional private working copies, and wake-lock support. |
| `pr` | `/review-comments` hands selected unresolved review comments to the agent; `/autofix` watches PR CI and `/autofix-stop` stops it. |
| `preview-system-prompt` | `/system-prompt` displays the assembled system prompt. |
| `secrets` | `/secret-list`; injects `fnox` secrets into shell commands and replaces secret values in tool results with reversible references. |
| `code-mode` | `code_mode` is the sole model-facing tool by default and runs bounded TypeScript programs through the shared code-mode runtime. Full Code Mode exposes Pi core tools, the explicitly registered `web.search` and `web.fetch` aliases, MCP, agents, and the typed `todo.*` and `night.plan` providers. Orchestration-only mode keeps MCP, agents, and trusted custom providers while hiding full-code-only capabilities. It also provides `/sandbox`, `/mcp`, and `/mcp-auth` controls. |
| `taptap` | Requires two `Esc` presses within 600ms to cancel a running agent turn, while preserving pi's idle and completion behaviors. |
| `todos` | The typed `todo.*` Code Mode provider manages file-backed todos, and `/todos` provides the interactive manager. |
| `tool-substitute` | Adds pi search-tool guidance and blocks Git writes inside jj repositories, converting simple safe Git operations where possible. |
| `usage` | `/usage` polls Claude and Codex/ChatGPT OAuth subscription windows and publishes usage and Codex pacing state. |
| `web` | `web_search` searches Kagi, `fetch_content` fetches pages or summarizes Git repositories, and `/kagi-status` validates the Kagi token. |
| `workspaces` | `/workspace` lists, creates, switches, and deletes jj workspaces, with optional Herdr integration. |

### Skills

The package currently includes one skill, `code-mode`, at
[`skills/code-mode/SKILL.md`](skills/code-mode/SKILL.md), with references
for agents, the full API, and MCP at
[`skills/code-mode/references/`](skills/code-mode/references/).

### Themes

The packaged themes are:

- `catppuccin-frappe`
- `catppuccin-latte`
- `catppuccin-macchiato`
- `rose-pine-dawn`
- `rose-pine-moon`

They are JSON theme files under [`themes/`](themes/).

## Install and update

Install the package with pi:

```sh
pi install git:github.com/babariviere/pi-extensions
```

pi installs the package in its managed package area and installs the package's
npm dependencies. The `pi` metadata in `package.json` then exposes the
extension entry points, skill directory, and theme files. Update installed
extensions with:

```sh
pi update --extensions
```

For a local checkout, install the current directory instead:

```sh
pi install ./
```

Run that command from this repository. Individual extensions can also be loaded
from a checkout through pi's normal `settings.json` extension configuration;
the extension-specific docs contain examples where relevant.

## Requirements

- Node.js `>=24.0.0`, as required by the shared code-mode runtime and used by CI.
- The pi host supplies the peer packages `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.
  The package installs its declared runtime dependencies such as `defuddle`,
  `parse5`, `shiki`, and `yaml`; code mode also consumes the shared
  `@babariviere/code-mode` runtime and its host-pi adapter.
- Optional integrations need their own tools and credentials. Examples include
  Kagi, `fnox`, Linear, GitHub CLI, jj, Herdr, and the platform facilities
  required by night mode or the background-agent controller.

## Configuration and credentials

Pi's normal extension and model settings remain in its settings files. The
following files and environment variables are used by extensions in this
repository; absent values generally use the defaults in source or the linked
extension README.

| Location or variable | Used by |
| --- | --- |
| `~/.pi/agent/settings.json` | Pi settings, `workspaces`, the user `nightMode` configuration, shell path, and manually loaded extensions. |
| `<cwd>/.pi/settings.json` | Project `nightMode` settings, which take precedence over user night settings when the project is trusted; project MCP configuration may also live here. |
| `~/.pi/agent/code-mode.json` and trusted `<cwd>/.pi/code-mode.json` | Code Mode configuration. Project values are merged over user values. Full Code Mode and sandbox settings are separate from pi's own config. |
| `~/.pi/agent/mcp.json` | Code Mode's MCP server configuration. Code Mode has no separate MCP credential store; OAuth/keyring behavior follows its MCP implementation. |
| `~/.pi/agent/secrets.json` | Per-machine `KAGI_SESSION_TOKEN` and `LINEAR_API_KEY` values read directly by those extensions. This file is not the source for the `secrets` extension. |
| Nearest `fnox.toml` | `secrets` discovers this file upward from the working directory and calls `fnox export --format json`. |
| `~/.pi/agent/background-agents.json` | Background-agent controller configuration, or the path in `BACKGROUND_AGENTS_CONFIG`. |
| `~/.pi/agent/background-agents.sock` | Background-agent controller socket, or the path in `PI_BACKGROUND_AGENTS_SOCKET`. |
| `~/.pi/agent/cache/usage-status/openai/pacing.json` | Persisted Codex pacing state managed by `usage`. |
| `~/.pi/agent/night/` | Default night-mode prompts, instructions, reports, archive, todos, and sandboxes. |
| `~/.herdr/workspaces` | Default root for managed jj workspaces. |

Useful environment controls include `PI_CODING_AGENT_DIR` (alternate pi agent
directory), `PI_AGENT_DIR` (MCP agent directory), `PI_TODO_PATH` (todo store),
`PI_USAGE_PACING=off` (disable Codex pacing at startup), `PI_GUARDRAIL=off`
(disable the guardrail at startup), and `HERDR_SOCKET_PATH` (alternate Herdr
socket). `PI_NIGHT_RUN` and `PI_BACKGROUND_AGENT_ATTEMPT` are internal markers
used when extensions spawn or join managed runs; do not set them casually.

### Secrets

Keep credentials out of this repository. `secrets.json` accepts either
`{"NAME":"value"}` or `{"secrets":{"NAME":"value"}}`; the `web` and
`linear` extensions read their named values from it or from the process
environment. The `secrets` extension is independent: it obtains values from
`fnox`, injects them into `bash` and user `!` commands, and scrubs tool results
and persisted details. It exposes secret names, never values. Pattern masking
is defense in depth, not a guarantee against every indirect or streamed leak;
review commands and logs before sharing them.

## Background agents and repository scope

The existing [`background-agents` extension](extensions/background-agents/README.md)
is part of this repository and is packaged by the `extensions/*/index.ts`
glob. Its Pi-side code is an owner-checked client and dashboard. The companion
controller is a separate Node process started with
`npm run background-agents:controller`; it owns its SQLite state and listens on
the configured Unix socket. The controller documentation covers its optional
Slack, Linear, Datadog, GitHub, Herdr, and systemd integrations.

This repository contains no evidence that a separate private project is bundled
here, so this README makes no such claim. The supported relationship documented
by the code is only the client/controller protocol and the optional integrations
of this existing extension. It is not a remote version of `night-mode`:
background-agent documentation explicitly keeps those systems separate.

Important controller boundaries are:

- The socket is owner-only by default (`0600`), checks ownership, and limits
  request size.
- Slack and Datadog sources are read-only. Linear polling is limited to the
  authenticated user's active cycle, with narrowly bounded forward state moves.
- Agents work in isolated attempts; the controller, not an agent, imports exact
  commits and performs GitHub effects. It creates reviewable PRs but has no merge
  operation. Questions remain private and read-only.
- Linux, systemd, cgroup v2, Herdr, Git, GitHub CLI, and `gh stack` are required
  for isolated controller attempts. Missing isolation capabilities fail closed.

Start the controller only after reading its configuration and deployment notes.
Do not put credentials in JSON configuration, command arguments, SQLite,
dashboard responses, or logs.

## Safety boundaries

These integrations are safeguards and workflow tools, not a universal security
boundary:

- `guardrail` catches known destructive command shapes. Its own documentation
  lists bypasses such as indirect mutations and destructive scripts.
- Code Mode's filesystem sandbox is configured through `code-mode.json` and is off
  by default for ordinary sessions. `read-only` and `workspace-write` enforce
  direct read/write paths; night mode enables its own workspace-oriented policy
  and read-only MCP policy by default. Treat shell/network access as capable of
  side effects and inspect the effective `/sandbox` status. Captured web
  capabilities are explicit aliases, not a generic view of sibling extension
  tools. Unselected siblings remain on Pi's native direct path. A trusted
  custom provider is available in orchestration-only mode unless it declares
  itself full-code-only.
- `night-mode` can hold a wake lock. The macOS `pmset` backend changes a
  persistent sleep setting and may need narrowly scoped passwordless sudo; a
  crash can require manual restoration. See its wake-lock documentation.
- `workspaces` can forget workspaces and remove managed directories, and
  `todos` can delete todo files. Confirm destructive actions and maintain
  backups where appropriate.
- `web`, Linear, PR helpers, MCP servers, and external CLIs act with the
  credentials and permissions supplied by the host. Limit those permissions and
  review network and repository mutations.

## Development

```sh
npm install
npm run typecheck
npm test
npm run fmt:check
```

`npm run fmt` applies Biome formatting. Focused checks include:

```sh
node --import tsx --test 'extensions/background-agents/**/*.test.ts'
npm run code-mode:evaluate -- extensions/code-mode/evaluation/corpus.jsonl --baseline edit-first
```

The CI workflow runs `npm ci`, `npm run typecheck`, and `npm test` on Node 24.

## Documentation map

- [Background agents](extensions/background-agents/README.md), including
  controller deployment, configuration, credentials, isolation, recovery, and
  socket protocol.
- [Guardrail](extensions/guardrail/README.md), including blocked command
  categories and known limitations.
- [Night mode](extensions/night-mode/README.md), including scheduling, usage
  guards, sandboxing, wake locks, and reports.
- [Secrets](extensions/secrets/README.md), including provider patterns,
  reference expansion, and masking caveats.
- [TapTap](extensions/taptap/README.md), including Escape handling and keybinding
  caveats.
- [Usage](extensions/usage/README.md), including Codex pacing semantics and
  persisted state.
- [Code-mode migration and configuration](extensions/code-mode/README.md).
- [Code-mode evaluation](extensions/code-mode/evaluation/README.md), including the
  JSONL format and experiment protocol.
- [Code-mode patch format](extensions/code-mode/NATIVE_APPLY_PATCH.md).
- [pi documentation](https://github.com/earendil-works/pi).
