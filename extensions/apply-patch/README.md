# Apply Patch

Registers `applyPatch`, an ordinary V4A file-editing tool. Native codemode calls it as:
```js
return await tools.applyPatch({ patch: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch" });
```

Selecting an OpenAI provider or GPT model deactivates `edit` and `write`; native
nested calls are blocked too. Switching away restores only tools disabled by this
extension, not explicit user exclusions. To exclude them for every model (including
virtual-model routes), add `-edit` and `-write` to pi's `defaultTools`.

Add, update, delete and move operations retain the existing Codex-compatible parser and change metadata. Direct calls receive a text summary; scripts receive `{ changes: [{ kind, path, moveTo? }] }`. Operations execute sequentially. A later error can leave earlier changes applied; there is no rollback.

The standalone `sandbox` extension guards every affected path, including both sides of a move. Without that extension the tool uses the host's normal filesystem permissions. The tool still passes through pi's native validation, permission and secret-redaction hooks.

This is not an OpenAI Responses native `apply_patch` declaration. It does not modify provider requests or implement that separate transport protocol.

Parser attribution and licensing are in [apply-patch.NOTICE](apply-patch.NOTICE) and [apply-patch.LICENSE](apply-patch.LICENSE).
