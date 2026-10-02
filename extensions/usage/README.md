# Usage

The usage extension owns subscription-usage polling for Claude and Codex / ChatGPT OAuth accounts. It publishes `usage:snapshot` events for other extensions and provides the `/usage` command.

For virtual models, polling follows the most recent successful physical
assistant response on the active session branch. Until that session has a
successful response, it falls back to the selected model. Model selections,
successful responses, branch navigation, and session switches update the usage
provider without treating failed or aborted requests as physical routes.
Ordinary physical model selections switch the subscription provider immediately;
an older response does not override the user's current selection.

## Commands

`/usage` or `/usage status` shows provider usage and reset times. The Codex 5h and weekly windows are informational and do not block tool calls.

Usage polling reads OAuth credentials and calls the provider usage endpoints. It does not use API keys, and the undocumented Codex endpoint may change or become unavailable.
