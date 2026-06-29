# pi-extensions

Personal extensions for [pi](https://github.com/earendil-works/pi).

| Extension | Description |
|-----------|-------------|
| `web` | `web_search` (Kagi) + `fetch_content` (defuddle.md / git clone) |
| `secrets` | Inject secrets from the `fnox` CLI into bash env, with output masking |
| `linear` | Resolve Linear issues and move them through workflow states |
| `pr` | GitHub pull request helpers |
| `context` | Context-window usage + session token/cost footer data |
| `footer` | Custom footer rendering |
| `tool-substitute` | Rewrite tool calls (e.g. git -> jj, grep -> rg) |
| `preview-system-prompt` | Dump the assembled system prompt |

## Install

This is a private repo, so install over SSH:

```bash
pi install git:git@github.com:babariviere/pi-extensions
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
