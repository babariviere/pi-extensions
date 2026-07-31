---
name: spindle-exec
description: >-
  Reference for `spindle_exec` TypeScript programs: Pi core tool signatures,
  extension/MCP/subagent namespaces, workflow helpers, named strings, return
  shapes, and error recovery. Load before the first `spindle_exec` call or after an
  argument-shape error.
---

# spindle_exec — core reference

One type-checked TS program in a fresh isolated QuickJS sandbox. Only the `return` value reaches the model; `print()`/`console.log` go to the activity widget. `π` is not a tool.

Available globals: `pi` and `extensions` (full code mode only), `mcp`, `agents`, `workflow`, `print`, `console`, `π`, and the bare aliases `parallel` / `pipeline` / `phase` / `log`. Nothing else exists — there is no `tools`, `memory`, `state`, `schema`, `compact`, `mesh`, `council`, `rlm`, `agent()`, or `budget`.

## `pi` core tools (full code mode only)

`pi.<tool>(arg)` — single arg: bare string (primary field) or options object. Multi-arg positional calls are accepted for `grep`/`find` (`pattern, path, limit`), `write` (`path, content`), and `edit` (`path, oldText, newText`); one-field tools (`read`/`bash`/`ls`) stay single-arg — a 2-arg call on those is a type error so the extra arg isn't silently dropped.

| Tool | Form | Returns |
|------|------|---------|
| `read` | `path` \| `{path,offset?,limit?}` | `string` |
| `bash` | `command` \| `{command,timeout?}` | `{ok:true,output,details}`; rejects on a nonzero exit (`settle:true` returns `{ok:false,output,details:null,exitCode,error}` instead) |
| `grep` | `pattern` \| `{pattern,path?,glob?,ignoreCase?,literal?,context?,limit?}` \| `(pattern, path?, limit?)` | `string` |
| `find` | `pattern` \| `{pattern,path?,limit?}` \| `(pattern, path?, limit?)` | `string` |
| `ls` | `path?` \| `{path?,limit?}` | `string` |
| `edit` | `{path,edits:[{oldText,newText}]}` \| `{path,oldText,newText}` \| `(path, oldText, newText)` | `{ok,output,details}` |
| `write` | `{path,content}` \| `(path, content)` | `{ok,output,details}` |

`bash` rejects on an ordinary nonzero exit; pass `settle:true` to get `{ok:false,output,details:null,exitCode,error}` instead of a rejection. Timeout, cancellation, approval, security, and spawn failures still reject. Other Pi core tool errors reject normally.

Aliases (normalized to canonical before the host validates args): `cmd`/`shell`/`cmdline`→`command`; Bash `timeout` is in seconds, while `timeoutMs` is converted from milliseconds to `timeout`; `query`/`regex`/`search`→`pattern`; `ic`/`caseInsensitive`→`ignoreCase`; `globPattern`→`glob`; `ctx`→`context`; `max`→`limit`; `file`/`dir`→`path`; `start`→`offset`; `old`→`oldText`; `new`/`replacement`→`newText`; `contents`/`body`/`text`→`content`. Misspelled keys still fail the excess-property type check.

When a program needs a string containing literal `${...}` (shell snippets, tool arguments, or grep patterns), do not use a TypeScript template literal: TypeScript will interpolate it. Use a plain quoted string or pass the content through the `strings` parameter and read it from `π.key`.

### Awkward payloads — always use `strings`/`π`

MUST pass through `strings` and read as `π.key`, never inline in `code`: multi-line file content (writes, edits, heredocs), JSON blobs, long prose (agent prompts, task text), and strings with literal `${...}`.

Inlining multi-line content nests it through three escape layers (file → JS `"..."` → JSON `code`); at that depth the model emits literal `\n`/`\t` instead of newlines, silently corrupting the file. Template literals also interpolate `${...}` you meant to keep literal. `strings` values cross only one JSON boundary and survive intact.

```ts
// strings: { body: "line1\nline2", panel: '[{"model":"..."}]', task: "analyze ..." }
await pi.write({ path: "/x.ts", content: π.body });
await pi.edit({ path: "/y.ts", oldText: π.oldChunk, newText: π.newChunk });
const panel = JSON.parse(π.panel) as Array<{ model: string }>;
const prompt = `Objective:\n\n${π.task}`;
```

Short single-line literals with no `${...}` are fine inline.

## `extensions` — tools registered by sibling extensions (full code mode only)

`extensions.<tool>(args)` resolves to `{content:Array<{type,text?,...}>,text:string,details?,isError:boolean,terminate?,source:{path,source,scope,origin,baseDir?}}`. Read `.text` for the output. In full code mode these tools are hidden from the model's direct tool list, so `extensions.*` is the only way to reach them.

## `tools` — cross-provider discovery + generic dispatch (full code mode only)

`tools` owns no tools; it enumerates and invokes actions across every provider (pi, extensions, mcp, agents). Use it to discover names/schemas at runtime, then call them on their own namespace.

- `tools.providers()` → `[{name, description}]` for every registered provider.
- `tools.list({provider?, namespace?, query?, limit?})` → `SpindleAction[]` (`ref, provider, name, description, inputSchema, namespace?`). No args lists everything, including captured `extensions.*` tools that are hidden from the direct tool list.
- `tools.catalog({provider?, limit?})` → provider/action head tree (navigation metadata).
- `tools.search({query, limit?})` → ranked `SpindleAction[]`.
- `tools.describe({ref})` → one action's full descriptor; read `inputSchema` before calling.
- `tools.call({ref, args?})` → invoke a ref computed at runtime (same path as `extensions.<tool>()`/`pi.<tool>()`). Prefer direct property calls for statically known tools.

Refs are namespaced (`extensions.<tool>`, `pi.grep`, `mcp.<server>.<tool>`). Calling a core-tool name on `tools` (e.g. `tools.read(...)`) throws with a hint to use `pi.read(...)`.

## `mcp` — MCP tools through pi-mcp-adapter

Spindle does not embed an MCP client; `mcp.*` forwards to the `mcp` gateway tool registered by the sibling `pi-mcp-adapter` extension, so `~/.pi/agent/mcp.json`, stored credentials, and per-server/per-tool disable rules all apply unchanged. See `<skill-dir>/references/mcp.md`.

## `agents` — custom markdown subagents

`agents.list()` / `agents.run({agent, task})` / `agents.runAll({tasks})`. These run agent definitions discovered on disk (`~/.pi/agent/agents/**`, `<cwd>/.pi/agents/**`) as child Pi sessions. See `<skill-dir>/references/agents.md`.

## `workflow` — fan-out, staged transforms, concurrency control

Reach for these when the work scales, not just for long programs. Triggers: fanning out over many items (roughly >10), needing a concurrency cap so you don't hammer the host, or running each item through the same ordered stages.

- `workflow.parallel(items, mapper, concurrency?)` or `workflow.parallel(thunks, concurrency?)` → results in input order. Prefer this over `Promise.all` when the set is large or you want to cap concurrency (e.g. 200 files, 8 at a time). Use plain `Promise.all` for a handful of independent calls.
- `workflow.pipeline(items, ...stages)` → each item passed through every stage. Use for repeated read->parse->validate->write flows instead of nested `.map`/`await` chains.
- `workflow.phase(name, options?)` / `workflow.item(item)` / `workflow.event(event)` / `workflow.configure({name?, description?})` structure a long program.
- `workflow.log(...values)` is `print`.
- `parallel`, `pipeline`, `phase`, and `log` are also available as bare globals.

There is no `workflow.agent()` and no token budget: use `agents.run(...)` directly.

## Error recovery: read the error, fix the shape, retry

The type checker runs before execution, so a shape mistake never executes. Read the line-numbered error and match the declared signature; do not guess. Common mistakes: calling a core tool bare (`grep(...)` → `pi.grep(...)`); 2 positional args on `read`/`bash`/`ls` (use an options object — positional is supported only for `grep`/`find`/`write`/`edit`).

## Batching

Batch independent operations in one program; keep dependent or conditional steps sequential. Use `Promise.all` for a few independent calls, `workflow.parallel(items, fn, N)` when fanning out over many items or capping concurrency, and `workflow.pipeline` for repeated staged transforms. Return only the compact final value — intermediate results stay in the sandbox and never enter the transcript.
