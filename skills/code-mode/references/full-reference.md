# Native codemode reference

## Globals and tools

Scripts are JavaScript async-function bodies in pi's QuickJS sandbox. Top-level `await` and `return` work. There is no Node.js, direct filesystem/network access, timers, TypeScript checker or legacy payload/state API.

- `tools.<name>(args)` calls a registered callable tool through pi's validation, permission and result middleware.
- `ALL_TOOLS` is an array of `{ name, description }` metadata.
- `await searchTools(query, { limit?, namespace? })` ranks callable tools. Default limit: 8.
- `await describeTool(name)` returns a description and declaration, or `undefined`.
- `text(value)`, `console.*` and top-level `return value` append model-facing output.
- `image(imageBlockOrDataUrl)` forwards an individual image block, for example from an MCP result.
- `exit()` finishes the script early. Always await work you intend to complete; unawaited calls are cancelled when the script finishes.
- `store(key, value)` and `load(key)` persist JSON values across successful scripts on the session branch. `store(key, undefined)` deletes a value.
- `models.*` exposes pi's model catalog and classifiers when enabled by the host. Consult the native tool description for its declarations.

A first-line options comment sets output budget and a hard deadline:

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
const results = await Promise.all([
  tools.read({ path: "package.json" }),
  tools.read({ path: "README.md", limit: 80 }),
]);
return results;
```

Output defaults to 10000 tokens. The sandbox has a 256 MB memory limit. Native tool schemas in the codemode description are authoritative; tools can be omitted from that description's inline budget and still be discoverable.

## Core tool inputs

| Tool | Input | Script result |
| --- | --- | --- |
| `read` | `{ path, offset?, limit? }` | Text, with normal pi truncation |
| `find` | `{ pattern, path?, limit? }` | Text |
| `grep` | `{ pattern, path?, glob?, literal?, ignoreCase?, context?, limit? }` | Text |
| `ls` | `{ path?, limit? }` | Text |
| `bash` | `{ command, timeout? }` | `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }` |
| `edit` | `{ path, edits: [{ oldText, newText }] }` | Text |
| `write` | `{ path, content }` | Text |
| `applyPatch` (separate extension) | `{ patch }` | `{ changes: [{ kind, path, moveTo? }] }` |

Only active direct tools, and registered codemode/deferred tools, are callable. Enable optional search tools in pi's `defaultTools` or `--tools` selection. Do not use a Python fallback when a tool is unavailable; inspect the current selection.

Bash returns up to 1 MiB to scripts, including on nonzero exit. Check `exit_code` and use `full_output_path` for larger output. Other failed, blocked or invalid calls reject. Tools with an output schema return `structuredContent`; schema-bearing error results can resolve with error data, so inspect the declared error fields too.

## File editing

Use `tools.edit({ path, edits: [{ oldText, newText }] })` for exact replacements and `tools.write({ path, content })` for full files. If an edit misses, reread the current file before retrying.

`tools.applyPatch({ patch })` accepts V4A patches beginning with `*** Begin Patch` and ending with `*** End Patch`. It supports Add/Update/Delete File, Move to, anchors, hunks and End of File. Patch operations run in order; a later error does not roll back earlier file changes. The optional sandbox extension guards paths, including moves.

Native scripts have no `payloads` argument. Use ordinary JavaScript strings, or read existing documents from files. For literal content containing `${...}`, avoid template-literal interpolation. Neither script failure nor store rollback reverses file or external tool mutations.
