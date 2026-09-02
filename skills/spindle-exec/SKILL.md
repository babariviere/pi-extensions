---
name: spindle-exec
description: >-
  Reference for `spindle_exec` TypeScript programs: Pi core tool signatures,
  extension/MCP/subagent namespaces, `mapLimit` fan-out, named payloads, return
  shapes, and error recovery. Load before the first `spindle_exec` call or after an
  argument-shape error.
---

# spindle_exec — core reference

One type-checked TS program in a fresh isolated QuickJS sandbox. Only the `return` value reaches the model; `print()`/`console.log` go to the activity widget. `π` is not a tool.

Available globals: `pi`, `extensions`, and `tools` (full code mode only), `mcp`, `agents`, `mapLimit`, `print`, `console`, `π`, `process`, the timer family (`setTimeout` / `clearTimeout` / `setInterval` / `clearInterval`), and the host APIs listed below. Nothing else exists: there is no `memory`, `state`, `schema`, `compact`, `mesh`, `council`, `rlm`, `agent()`, `budget`, or `workflow` (and no bare `parallel` / `pipeline` / `phase` / `log` aliases).

The language level is ES2025: `Object.groupBy`, `Map.groupBy`, `Promise.withResolvers`, `Promise.try`, the `Set` combinators (`union`, `intersection`, `difference`, `isSubsetOf`), the iterator helpers (`values().map(...).toArray()`), `RegExp.escape`, `Array.prototype.toSorted`/`with`/`toSpliced`, `Float16Array` and `Error.isError` are all available and typed. `Array.fromAsync`, `JSON.rawJSON`, `Symbol.dispose` and `Temporal` are not.

## Host APIs

These are polyfilled, and injected only when your program mentions them by name (so reaching one dynamically through `globalThis["Text" + "Encoder"]` will not work).

| API | Notes |
|------|-------|
| `TextEncoder` / `TextDecoder` | utf-8 only; `TextDecoder` does not stream and rejects any other label |
| `URL` / `URLSearchParams` | pragmatic, not WHATWG-conformant: authority parsing needs an explicit `//`, hostnames are lowercased but not punycode-normalized |
| `atob` / `btoa` | `btoa` throws on input outside Latin-1; encode with `TextEncoder` first |
| `structuredClone` | a real clone: keeps `Map`, `Set`, `Date`, `RegExp`, typed arrays, handles cycles, throws on functions and promises |
| `crypto.getRandomValues` / `crypto.randomUUID` | draws on a 4096-byte pool of host entropy and throws once drained, because a synchronous call cannot reach the async host bridge. No `crypto.subtle` |
| `queueMicrotask` | |
| `performance.now` | milliseconds since program start, wall clock, not monotonic |

There is deliberately no `fetch`, no `crypto.subtle` and no `WebAssembly`: the audited host-call table (`pi.*`, `extensions.*`, `mcp.*`) is meant to be the only route out of the sandbox. For network access use a `pi.bash` command or an MCP tool.

`Intl` and `Atomics` do not exist. TypeScript's `lib.es5` declares both, so they type-check and then fail at runtime; `Intl` in particular is absent because the engine ships no ICU data. Do not use `toLocaleString` for locale-aware output, it ignores the locale argument.

`process` is a minimal shim: `process.env` is an allowlisted host snapshot (HOME, USER, LOGNAME, SHELL, PWD, PATH, LANG, LC_*, TERM, TMPDIR, XDG_*), `process.platform`/`process.arch` are host facts, and `process.cwd()` returns the session working directory. Sensitive variables are never exposed; for secrets in bash use the `<\\secret:NAME>` reference path.

## `pi` core tools (full code mode only)

`pi.<tool>(arg)` — single arg: bare string (primary field) or options object. Multi-arg positional calls are accepted for `grep`/`find` (`pattern, path, limit`), `write` (`path, content`), and `edit` (`path, oldText, newText`); one-field tools (`read`/`bash`/`ls`) stay single-arg — a 2-arg call on those is a type error so the extra arg isn't silently dropped.

| Tool | Form | Returns |
|------|------|---------|
| `read` | `path` \| `{path,offset?,limit?}` | `string` |
| `bash` | `command` \| `{command,timeout?,cwd?,env?,stdin?}` | `{ok:true,output,details}`; rejects on a nonzero exit (`settle:true` returns `{ok:false,output,details:null,exitCode,error}` instead) |
| `grep` | `pattern` \| `{pattern,path?,glob?,ignoreCase?,literal?,context?,limit?}` \| `(pattern, path?, limit?)` | `string` |
| `find` | `pattern` \| `{pattern,path?,limit?}` \| `(pattern, path?, limit?)` | `string` |
| `ls` | `path?` \| `{path?,limit?}` | `string` |
| `edit` | `{path,edits:[{oldText,newText}]}` \| `{path,oldText,newText}` \| `(path, oldText, newText)` | `{ok,output,details}` |
| `write` | `{path,content}` \| `(path, content)` | `{ok,output,details}` |

`bash` rejects on an ordinary nonzero exit; pass `settle:true` to get `{ok:false,output,details:null,exitCode,error}` instead of a rejection. Timeout, cancellation, approval, security, and spawn failures still reject. Other Pi core tool errors reject normally.

Aliases (normalized to canonical before the host validates args): `cmd`/`shell`/`cmdline`→`command`; `workdir`/`workingDir`/`workingDirectory`→`cwd`; Bash `timeout` is in seconds, while `timeoutMs` is converted from milliseconds to `timeout`; `query`/`regex`/`search`→`pattern`; `ic`/`caseInsensitive`→`ignoreCase`; `globPattern`→`glob`; `ctx`→`context`; `max`→`limit`; `file`/`dir`→`path`; `start`→`offset`; `old`→`oldText`; `new`/`replacement`→`newText`; `contents`/`body`/`text`→`content`. Misspelled keys still fail the excess-property type check.

`pi.bash` per-call extras:

- `cwd` — absolute working directory for this one command (must exist).
- `env` — extra variables **merged over** the shell environment (override, not replace).
- `stdin` — text piped to the command. This is the canonical way to run a multiline script on a remote host, with no quoting layers: `pi.bash({ command: 'ssh hezflix bash -s', stdin: π.script })`. Never build `echo ${JSON.stringify(π.script)} | ssh ...` — the `\n` escapes survive to the remote shell and mangle the script.

Env values and stdin are redacted from recorded surfaces (audits, previews, session files); the live command still receives them.

When a program needs a string containing literal `${...}` (shell snippets, tool arguments, or grep patterns), do not use a TypeScript template literal: TypeScript will interpolate it. Use a plain quoted string or pass the content through the `payloads` parameter and read it from `π.key`.

### Awkward payloads — always use `payloads`/`π`

MUST pass through `payloads` and read as `π.key`, never inline in `code`: multi-line file content (writes, edits, heredocs), JSON blobs, long prose (agent prompts, task text), and strings with literal `${...}`.

Inlining multi-line content nests it through three escape layers (file → JS `"..."` → JSON `code`); at that depth the model emits literal `\n`/`\t` instead of newlines, silently corrupting the file. Template literals also interpolate `${...}` you meant to keep literal. `payloads` values cross only one JSON boundary and survive intact.

```ts
// payloads: { body: "line1\nline2", panel: '[{"model":"..."}]', task: "analyze ..." }
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

`agents.list()` / `agents.run({agent, task})` / `agents.runAll({tasks})` / `agents.start({agent, task})` / `agents.wait({runId})` / `agents.status()` / `agents.cancel({runId})`. These run agent definitions discovered on disk (`~/.pi/agent/agents/**`, `<cwd>/.pi/agents/**`) as child Pi sessions. `run`/`runAll` block for a bounded wait window: a result with `state: "running"` means the child is still working, keep its `runId` and resume with `agents.wait` (or let the finished result arrive as a follow-up message). See `<skill-dir>/references/agents.md`.

## `mapLimit` — bounded-concurrency fan-out

Reach for it when the work scales, not just for long programs. Triggers: fanning out over many items (roughly >10), or needing a concurrency cap so you don't hammer the host.

- `mapLimit(items, mapper, concurrency?)` or `mapLimit(thunks, concurrency?)` → results in input order.
- Prefer it over `Promise.all` when the set is large or you want to cap concurrency (e.g. 200 files, 8 at a time). `Promise.all` receives promises that have already started, so it cannot bound how many run at once.
- Concurrency is unbounded when omitted; pass a number or `{ concurrency }`.
- `Promise.all` is instrumented: called with 4 or more entries it reports per-item progress to the activity widget. Use it for a handful of independent calls.

There is no `workflow` namespace, no `pipeline` helper, no `phase`/`log` aliases, no `workflow.agent()`, and no token budget. For staged transforms, chain `mapLimit` calls or write a plain loop; for subagents use `agents.run(...)` directly.

## Error recovery: read the error, fix the shape, retry

The type checker runs before execution, so a shape mistake never executes. Read the line-numbered error and match the declared signature; do not guess. Common mistakes: calling a core tool bare (`grep(...)` → `pi.grep(...)`); 2 positional args on `read`/`bash`/`ls` (use an options object — positional is supported only for `grep`/`find`/`write`/`edit`).

## Batching

Batch independent operations in one program; keep dependent or conditional steps sequential. Use `Promise.all` for a few independent calls and `mapLimit(items, fn, N)` when fanning out over many items or capping concurrency. Return only the compact final value: intermediate results stay in the sandbox and never enter the transcript.
