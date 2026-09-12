# Native OpenAI apply_patch integration boundary

## Status

Code Mode cannot safely enable the native OpenAI Responses `apply_patch` tool through pi 0.85.1 extension middleware.

The nested `pi.applyPatch({ patch })` implementation is the supported fallback. It accepts the model-familiar V4A format while retaining pi's normal tool lifecycle, filesystem sandbox, audit projection, and edit metrics.

## Why request injection is unsafe

An extension can use `before_provider_request` to append `{ "type": "apply_patch" }` to an OpenAI Responses request. That is only the first part of the protocol.

A complete native round trip must also:

1. Decode streamed `apply_patch_call` output items.
2. Preserve the item ID, call ID, status, path, operation type, and V4A diff.
3. Execute the operation through pi's normal tool lifecycle.
4. Return exactly one `apply_patch_call_output` for each call ID.
5. Replay prior native calls and outputs correctly on subsequent requests.

Pi 0.85.1's OpenAI Responses adapter recognizes ordinary `function_call` and `custom_tool_call` items, but not `apply_patch_call`. Its replay path emits `function_call_output` or `custom_tool_call_output`, not `apply_patch_call_output`. The `after_provider_response` extension event exposes status and headers only, so an extension cannot repair stream parsing there.

Injecting the request tool without provider support would allow the model to emit a patch that pi silently drops. Code Mode must not advertise native support until the complete response and replay protocol is available.

## Required upstream changes

The preferred implementation belongs in `@earendil-works/pi-ai`, in the shared OpenAI Responses conversion and stream-processing layer used by OpenAI, Azure OpenAI, and Codex transports.

The provider-neutral contract needs to distinguish a native patch call from an ordinary function tool also named `apply_patch`. The distinction must survive session persistence and replay. A provider implementation should then:

- Serialize the native declaration as `{ "type": "apply_patch" }` only for compatible Responses transports and models.
- Parse create, update, and delete operations from `apply_patch_call` stream items.
- Map the call to an executable pi tool without losing native-origin metadata.
- Serialize completed and failed results as `apply_patch_call_output` with the original call ID.
- Preserve native calls and outputs when reconstructing conversation history.
- Fall back to an ordinary function or nested V4A tool on unsupported transports.

A complete custom provider registered by an extension could technically own this entire transport, parser, and replay loop. Code Mode does not do that because it would duplicate authentication, retries, SSE and WebSocket handling, usage accounting, reasoning replay, compatibility behavior, and future protocol maintenance.

## Required upstream tests

Provider tests must cover:

- Exact request serialization for the native tool declaration.
- Create, update, and delete stream items.
- Completed and failed call outputs.
- Full parse, execute, output, and replay round trips.
- Distinguishing native calls from a function tool named `apply_patch`.
- OpenAI Responses, Azure OpenAI Responses, Codex SSE, and Codex WebSocket transports.
- Unknown or inactive patch executors failing explicitly rather than being dropped.

## Code Mode activation criteria

Code Mode may add a native profile only after the host SDK exposes a stable provider-neutral capability that passes the tests above. Integration must then prove that native and nested patches have equivalent:

- Workspace results.
- Sandbox and path validation.
- `tool_call` and `tool_result` middleware behavior.
- Audit redaction.
- Edit metrics.
- Failure recovery.

Native support must be capability-detected from the active provider and model. Model-name matching alone is insufficient because OpenAI-compatible proxies can expose the same model IDs without supporting native Responses items.

## References

- OpenAI Apply Patch guide: <https://developers.openai.com/api/docs/guides/tools-apply-patch>
- OpenAI GPT-5.1 prompting guide: <https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-1_prompting_guide>
- Pi extension provider hooks: `docs/extensions.md` in the installed pi package
