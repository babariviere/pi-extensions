# Usage

The usage extension owns subscription-usage polling for Claude and Codex / ChatGPT OAuth accounts. It publishes `usage:snapshot` and `usage:pacing` events for other extensions and provides the `/usage` command.

## Commands

- `/usage` or `/usage status` shows provider usage, reset times, and the active Codex pacing window.
- `/usage pacing on` enables pacing.
- `/usage pacing off` disables pacing for the current session.
- `/usage pacing off daytime` disables pacing until the local 21:00 boundary. The override is persisted so it also applies to another pi session.

Pacing is enabled by default. Set `PI_USAGE_PACING=off` to disable it when pi starts. The weekly hard stop and pacing warnings apply only to Codex models, and the override remains advisory control for the current user.

## Codex pacing semantics

The weekly budget is divided across fixed local-time windows:

- Day windows are 07:00 inclusive through 21:00 exclusive.
- Night windows are 21:00 through the next day's 07:00.
- A weekday day window has weight 1. A weekday night window has weight 0.5.
- Every weekend window has weight 0.5. Weekend nights are not compounded to 0.25.
- Weekend classification uses the window start date. For example, Saturday 21:00 through Sunday 07:00 is a Saturday weekend window.

At each window boundary, the remaining weekly budget is allocated across the current and all later windows through the provider's next reset, normalized by their weights. An allowance is fixed when a window is first observed. Unused budget is therefore available to later windows, but polling again during the same window does not change its allowance. The current window is retained when a provider reset occurs in the middle of it, so provider reset does not move the 07:00 or 21:00 calendar boundaries. The first weekly usage observation establishes a baseline, including after a provider reset. Historical usage reduces the remaining weekly budget but does not consume the new window’s allowance. Existing cached window usage is not retroactively adjusted. Persisted usage is tracked by positive cumulative deltas, without double counting.

The weekly 100% stop is a hard stop. A warning is delivered once per window at 90% of that window's allowance. Use `/usage pacing off` to continue when pacing blocks a tool call. Pacing state is stored at `~/.pi/agent/cache/usage-status/openai/pacing.json` with restrictive file permissions. Version 2 reset-anchored ledgers are migrated to the fixed-window format. Historical usage remains the weekly baseline during migration, rather than being charged to the newly active window, so an old reset-anchored record cannot keep Monday 07:00 blocked.

Usage polling reads OAuth credentials and calls the provider usage endpoints. It does not use API keys, and the undocumented Codex endpoint may change or become unavailable. Pacing is advisory cache state and an unwritable cache does not break usage polling.
