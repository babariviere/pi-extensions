# Scoped model router

Registers the optional virtual model `router/auto`. It never changes your selected
model automatically. Select it with `/model` or `pi --model router/auto`.

## Routing

- `off`, `minimal`, `low`, and `medium`: use `cheapModel`, or the authenticated
  physical model with the lowest positive catalog input-plus-output rate.
- `high`, `xhigh`, and `max`: use the explicitly configured `strongModel`. Missing
  configuration fails with an actionable error. Price is not used to infer quality.
- Tool continuations stay on the last successful physical model. Retries stay on
  the failed physical model, preserving thinking level and prompt caches.
- Compaction and other direct requests use `directModel`, then `cheapModel`, then
  the cheapest priced candidate, with thinking off.

Every choice is restricted to authenticated models in the session's scoped set
(`enabledModels` or `--models`), when configured. Other virtual models are excluded.
If scope contains only `router/auto`, routing fails rather than widening the scope.
The initial choice requires image support when the transcript contains images.
Changing credentials or scope never silently redirects a sticky continuation.

## Configuration

Use `<agent-dir>/router.json` and optionally trusted project `.pi/router.json`:

```json
{
  "cheapModel": "openai-codex/gpt-5.6-luna",
  "strongModel": "openai-codex/gpt-6.1-sol"
}
```

IDs are exact `provider/model` identifiers, not patterns or thinking suffixes.
Explicitly selected models may have zero catalog prices, useful for local models.
Automatic price selection skips zero or invalid prices. Models and availability
come from the current host catalog, not a hardcoded model list.

For a scoped setup, include the physical models alongside the router in settings:

```json
{
  "enabledModels": [
    "router/auto",
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-6.1-sol"
  ]
}
```

Selecting the router does not switch mid-turn from planning to implementation.
Each new user input can choose a different model based on the selected thinking
level, which may incur a cache miss. Pi clamps thinking levels to model support,
handles routed context limits, and persists physical responses for resume/branches.
The footer displays selection and dispatch separately. No classifier call, extra
credentials, network request, or permission bypass is added by the router itself.

Generic subagents inherit the current physical catalog model, not `router/auto`.
Their existing provider/scope/price restrictions still apply. The apply-patch
extension follows physical OpenAI responses and blocks edit/write before execution;
see [Apply Patch](../apply-patch/README.md) for first-request declaration caveats.
