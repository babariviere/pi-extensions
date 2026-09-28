# Usage

The usage extension owns subscription-usage polling for Claude and Codex / ChatGPT OAuth accounts. It publishes `usage:snapshot` events for other extensions and provides the `/usage` command.

## Commands

`/usage` or `/usage status` shows provider usage and reset times. The Codex 5h and weekly windows are informational and do not block tool calls.

Usage polling reads OAuth credentials and calls the provider usage endpoints. It does not use API keys, and the undocumented Codex endpoint may change or become unavailable.
