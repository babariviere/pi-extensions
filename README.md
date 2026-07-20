# pi-extensions

Personal extensions for [pi](https://github.com/earendil-works/pi).

| Extension | Description |
|-----------|-------------|
| `web` | `web_search` (Kagi) + `fetch_content` (local defuddle / git clone) |
| `secrets` | Inject secrets from the `fnox` CLI into bash env, with output masking |
| `linear` | Resolve Linear issues and move them through workflow states |
| `workspaces` | Manage jj workspaces (list/create/switch/delete) with herdr integration |
| `subagents` | Discover custom agents and spawn them headlessly, or as live panes in a dedicated herdr tab |
| `pr` | GitHub pull request helpers |
| `context` | Context-window usage + session token/cost footer data |
| `footer` | Custom footer rendering |
| `tool-substitute` | Rewrite tool calls (e.g. git -> jj, grep -> rg) |
| `todos` | File-based todos in `.pi/todos` with a `/todos` TUI manager ([origin](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/todos.ts)) |
| `preview-system-prompt` | Dump the assembled system prompt |

## Install

```bash
pi install git:github.com/babariviere/pi-extensions
```

pi clones it into `~/.pi/agent/git/...` and runs `npm install`. Pull updates
on any machine with:

```bash
pi update --extensions
```

For local development against this checkout (hot-reloadable), point pi at the
path instead of the git source:

```bash
pi install ./   # from this directory
```

## Secrets and runtime config

Two independent mechanisms, do not conflate them:

- **`secrets.json`** (`~/.pi/agent/secrets.json`) holds per-machine tokens that
  individual extensions read directly for their own use, e.g. `KAGI_SESSION_TOKEN`
  (web) and `LINEAR_API_KEY` (linear). These are **never** injected into bash or
  exposed to the agent context. Schema: `{ "NAME": "value" }` or
  `{ "secrets": { "NAME": "value" } }`. Never committed here.
- **`secrets` extension** sources secrets from the **`fnox` CLI** (not
  `secrets.json`), injects them as env vars into bash commands, and masks their
  values in tool output.

## Develop

```bash
npm install      # installs parse5 (used by web)
npm run typecheck
npm test
```

The pi SDK packages (`@earendil-works/pi-*`, `typebox`) are provided by the pi
host at runtime and declared as `peerDependencies`.
