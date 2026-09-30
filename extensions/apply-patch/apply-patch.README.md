# Local ApplyPatch provider

This provider implements the local `pi.applyPatch({ patch })` tool using the OpenAI Codex V4A patch format.

## Provenance

The engine, parser, filesystem behavior, and translated tests are ported from OpenAI Codex at pinned commit [`9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a`](https://github.com/openai/codex/tree/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a), under the Apache License 2.0. See `apply-patch.LICENSE` and `apply-patch.NOTICE`.

Relevant upstream sources:

- [`parser.rs`](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/apply-patch/src/parser.rs)
- [`streaming_parser.rs`](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/apply-patch/src/streaming_parser.rs)
- [`seek_sequence.rs`](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/apply-patch/src/seek_sequence.rs)
- [`file_update.rs`](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/apply-patch/src/file_update.rs)
- [`text_file.rs`](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/apply-patch/src/text_file.rs)
- [file-update tests](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/apply-patch/src/file_update_tests.rs), [scenario tests](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/apply-patch/tests/suite/scenarios.rs), and [integration test entry point](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/apply-patch/tests/all.rs)

## Semantics

- The parser accepts lenient V4A input, including environment ID metadata, which is validated and ignored locally. It does not accept stacked empty anchors or pure hunkless moves.
- Add, Move, Update, and Delete operations run sequentially. Add/Move overwrite existing destinations. Duplicate paths are processed in order. If a later operation fails, earlier successful operations remain applied.
- The complete patch is parsed and every path is sandbox-preflighted before mutation. Each operation's sandbox guard is checked again immediately before that operation runs.
- Path policy delegates to the sandbox allowlist. Absolute paths, `..`, and symlinks are supported when the allowlist permits them. This provider does not impose a separate workspace-relative restriction.
- The default newline mode is legacy `NormalizeToLf`. This is not a blanket conversion: untouched carriage-return remnants are retained, matching the Rust legacy behavior. Set `CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS=1` to opt into per-line line-ending preservation.
- Added files end with a final LF. Updates end with a final newline.

The public tool API and result metadata remain Pi's `pi.applyPatch({ patch })` contract. There is no native OpenAI Responses integration here. Rust remote routing, CLI stdout behavior, and Rust IO error wording are not promised by this local provider.
