# Usage

The usage extension owns subscription-usage polling for Claude and Codex / ChatGPT OAuth accounts. It publishes `usage:snapshot` events for other extensions and provides the `/usage` command.

For virtual models, polling follows the most recent successful physical
assistant response on the active session branch. Until that session has a
successful response, it falls back to the selected model. Model selections,
successful responses, branch navigation, and session switches update the usage
provider without treating failed or aborted requests as physical routes.
Ordinary physical model selections switch the subscription provider immediately;
an older response does not override the user's current selection.

## One poller per provider

Any number of pi processes share one poller per subscription provider. The
process that needs a provider and holds its lease (`lease.json`, renewed each
minute) fetches usage; every other process watches the shared cache and
republishes it. The lease is released when the holder switches provider or
shuts down, and taken over when the holder exits or stops renewing it for
2.5 minutes. A holder without usable OAuth credentials releases it.

Files live under `<agentDir>/cache/usage-status/<provider>/`, where `agentDir`
is pi's agent directory (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`), so each
auth source keeps its own cache. Other local tools can read `cache.json`
without polling:

```json
{ "fetchedAt": 1760000000000, "snapshot": { "provider": "openai", "windows": [{ "label": "5h", "usedPercent": 12, "resetsAt": "2025-10-09T12:00:00.000Z" }] } }
```

`fetchedAt` is the epoch ms of the provider response. A cache that stops
updating means no pi process currently uses that provider.

## Commands

`/usage` or `/usage status` shows provider usage, the current poller, and reset times. The Codex 5h and weekly windows are informational and do not block tool calls.

Usage polling reads OAuth credentials through pi's credential store, which refreshes expired tokens, then falls back to Claude Code's keychain entry or Codex CLI credentials. It calls the provider usage endpoints, does not use API keys, and the undocumented Codex endpoint may change or become unavailable.
