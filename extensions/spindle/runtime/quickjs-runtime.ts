import { randomBytes } from "node:crypto";
import releaseSyncVariant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { ENTROPY_POOL_BYTES, guestPolyfillPlan } from "./guest-polyfills.ts";
import { runAbortable, settleWithin } from "../async-settlement.ts";
import { piBashExitMetadata } from "../core/pi-bash-error.ts";
import { mapGuestErrorText, parseGuestSourceMap, type GuestSourceMap } from "./source-map.ts";
import { transpileSpindleCode } from "./type-checker.ts";

export type SpindleSandboxTerminationReason = "completed" | "runtime_error" | "timed_out" | "aborted";

export interface SpindleSandboxResult {
	value: unknown;
	logs: string[];
	terminationReason: SpindleSandboxTerminationReason;
	error?: string;
}

export interface SpindleSandboxOptions {
	timeoutMs: number;
	memoryLimitBytes: number;
	maxLogChars?: number;
	strings?: Record<string, string>;
	/**
	 * JSON text of the source map for `transpiledCode`, used to rewrite guest
	 * stack positions back to the program the model wrote. Ignored when the
	 * runtime transpiles `code` itself (it then uses its own emitted map).
	 */
	sourceMap?: string;
	/** Injected as the guest's `process` global; the host filters the env allowlist. */
	process?: {
		env: Record<string, string>;
		platform: string;
		arch: string;
		cwd: string;
	};
	signal?: AbortSignal;
	/**
	 * Install the host-API polyfill layer (runtime/guest-polyfills.ts). Defaults
	 * to true. Tests that assert what the bare engine ships set it to false.
	 */
	polyfills?: boolean;
	minimumTimeoutMsForHostCall?(ref: string, args: Record<string, unknown>): number | undefined;
	transpiledCode?: string;
}

export type SpindleHostCall = (ref: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

type QuickJsModule = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>;

let quickJsModulePromise: Promise<QuickJsModule> | undefined;

const quickJsModule = (): Promise<QuickJsModule> => {
	quickJsModulePromise ??= newQuickJSWASMModuleFromVariant(releaseSyncVariant);
	return quickJsModulePromise;
};

export const GUEST_SETUP = `
(() => {
const __spindleBridge = globalThis.__spindleHostCall;
delete globalThis.__spindleHostCall;
const __spindleAbortReason = (signal) => {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
};
let __spindleNextCallId = 1;
// A guest AbortSignal cannot cross the JSON boundary, so a call carrying one is
// tagged with an id instead: the host gives that call its own AbortController,
// and an abort on the guest side sends spindle.$cancel with the same id. The
// signal key is stripped here so it never reaches a tool's argument schema.
const __call = async (ref, args) => {
  const payload = args ?? {};
  const signal =
    payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload.signal : undefined;
  if (!signal || typeof signal !== "object" || typeof signal.aborted !== "boolean") {
    return __spindleBridge(ref, payload);
  }
  if (signal.aborted) throw __spindleAbortReason(signal);
  const rest = {};
  for (const key of Object.keys(payload)) if (key !== "signal") rest[key] = payload[key];
  const callId = __spindleNextCallId++;
  rest.__spindleCallId = callId;
  // The bridge promise always gets a handler: when the abort wins the race, the
  // call's own later rejection must not surface as an unhandled rejection.
  const settled = __spindleBridge(ref, rest).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => {
      void __call("spindle.$cancel", { callId });
      resolve({ ok: false, error: __spindleAbortReason(signal) });
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const outcome = await Promise.race([settled, aborted]);
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};
const __spindleProcessInfo = globalThis.__spindleProcess ?? { env: {}, platform: "unknown", arch: "unknown", cwd: "" };
delete globalThis.__spindleProcess;
// Minimal process shim: the host injects an allowlisted env snapshot
// (HOME, USER, LOGNAME, SHELL, PATH, LANG, LC_*, TERM, TMPDIR, XDG_*), so no
// secret ever enters the sandbox. cwd() is the agent session's directory.
globalThis.process = Object.freeze({
  env: Object.freeze(__spindleProcessInfo.env ?? {}),
  platform: __spindleProcessInfo.platform,
  arch: __spindleProcessInfo.arch,
  cwd: () => __spindleProcessInfo.cwd,
});
const __piToolNames = ["read","bash","edit","write","grep","find","ls"];
const __piStringFields = { bash: "command", read: "path", ls: "path", grep: "pattern", find: "pattern" };
// Per-tool key aliases. The runtime normalizes them to the canonical form
// before the host validates args; unit-converting aliases are handled separately
// in __normalizePiArgs. This lets a model that writes { query, regex, ... }
// or { file } instead of { pattern } / { path } still succeeds on the first
// call. Keep these in sync with the PiToolsApi overloads in guest-types.ts so
// the type-checker accepts the same spellings it coercion-handles at runtime.
const __piArgAliases = {
  bash: { cmd: "command", shell: "command", cmdline: "command", workdir: "cwd", workingDir: "cwd", workingDirectory: "cwd" },
  find: { query: "pattern", regex: "pattern", search: "pattern", max: "limit" },
  grep: {
    query: "pattern", regex: "pattern", search: "pattern",
    ic: "ignoreCase", caseInsensitive: "ignoreCase",
    globPattern: "glob",
    max: "limit", ctx: "context",
  },
  read: { file: "path", max: "limit", start: "offset" },
  ls: { dir: "path", file: "path", max: "limit" },
  edit: { file: "path", old: "oldText", new: "newText", replacement: "newText" },
  write: { file: "path", contents: "content", body: "content", text: "content" },
};
// Multi-arg positional order, used only when a call passes >= 2 args. The
// one-field tools (read/bash/ls) are intentionally absent: their bare-string
// form already covers the 1-arg case, and a 2-arg call should hit the
// type-checker's wrong-arity (2554) and be corrected to an options object
// rather than silently dropping the second argument.
const __piPositionalFields = {
  grep: ["pattern", "path", "limit"],
  find: ["pattern", "path", "limit"],
  write: ["path", "content"],
  edit: ["path", "oldText", "newText"],
};
const __positionalToArgs = (name, rest) => {
  const order = __piPositionalFields[name];
  if (!order) return rest.length > 0 ? rest[0] : {};
  const out = {};
  for (let i = 0; i < rest.length && i < order.length; i++) {
    const v = rest[i];
    if (v !== undefined) out[order[i]] = v;
  }
  return out;
};
const __normalizePiArgs = (name, args) => {
  const field = __piStringFields[name];
  if (typeof args === "string" && field) return { [field]: args };
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  const aliases = __piArgAliases[name];
  let out = args;
  if (name === "bash" && "timeoutMs" in out) {
    out = Object.assign({}, args);
    if (!("timeout" in out)) {
      const timeoutMs = out.timeoutMs;
      out.timeout = typeof timeoutMs === "number" ? timeoutMs / 1000 : timeoutMs;
    }
    delete out.timeoutMs;
  }
  // settle is a guest-only directive (settles nonzero exits instead of
  // rejecting); strip it so it never reaches the host/bash schema.
  if (name === "bash" && "settle" in out) {
    if (out === args) out = Object.assign({}, args);
    delete out.settle;
  }
  if (aliases) {
    for (const alias in aliases) {
      const canonical = aliases[alias];
      if (alias in out) {
        if (out === args) out = Object.assign({}, args);
        if (!(canonical in out)) out[canonical] = out[alias];
        delete out[alias];
      }
    }
  }
  // The declared batch shape uses the same short keys as the single-edit form
  // ({ old, new }); pi core wants oldText/newText, and the alias table above
  // only rewrites top-level keys.
  if (name === "edit" && Array.isArray(out.edits)) {
    let touched = false;
    const edits = out.edits.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      if (!("old" in entry) && !("new" in entry) && !("replacement" in entry)) return entry;
      touched = true;
      const mapped = Object.assign({}, entry);
      if ("old" in mapped) {
        if (!("oldText" in mapped)) mapped.oldText = mapped.old;
        delete mapped.old;
      }
      if ("new" in mapped) {
        if (!("newText" in mapped)) mapped.newText = mapped.new;
        delete mapped.new;
      }
      if ("replacement" in mapped) {
        if (!("newText" in mapped)) mapped.newText = mapped.replacement;
        delete mapped.replacement;
      }
      return mapped;
    });
    if (touched) {
      if (out === args) out = Object.assign({}, args);
      out.edits = edits;
    }
  }
  if (name === "edit" && !Array.isArray(out.edits) && ("oldText" in out || "newText" in out)) {
    if (out === args) out = Object.assign({}, args);
    const edit = {};
    if ("oldText" in out) edit.oldText = out.oldText;
    if ("newText" in out) edit.newText = out.newText;
    out.edits = [edit];
    delete out.oldText;
    delete out.newText;
  }
  return out;
};
// The pi proxy accepts: a bare string (primary field), an options object, or
// a positional spread mapped by __piPositionalFields. 0/1 args preserve the
// legacy (args = {}) default so existing programs are unchanged.
globalThis.pi = new Proxy({}, {
  get(_target, property) {
    if (property === "then") return undefined;
    const name = String(property);
    return (...rest) => {
      let args;
      if (rest.length <= 1) {
        const first = rest.length === 1 ? rest[0] : undefined;
        args = first === undefined ? {} : first;
      } else {
        args = __positionalToArgs(name, rest);
      }
      // bash rejects on an ordinary nonzero exit; settle:true returns
      // {ok:false, exitCode, ...} instead (opt-in). Other failures still reject.
      const settle = name === "bash" &&
        typeof args === "object" && args !== null && args.settle === true;
      const call = __call("pi." + name, __normalizePiArgs(name, args));
      if (!settle) return call;
      return call.catch((error) => {
        const message = typeof error?.message === "string" ? error.message : String(error);
        const exit = error && error.__spindleBashExit;
        if (exit && Number.isSafeInteger(exit.exitCode) && exit.exitCode > 0 &&
            typeof exit.output === "string") {
          return {
            ok: false,
            output: exit.output,
            details: null,
            exitCode: exit.exitCode,
            error: message,
          };
        }
        // Fallback for a bash result that never reached the classifier (an
        // extension-owned override, for example).
        const match = /(?:^|\\n\\n)Command exited with code (\\d+)$/.exec(message);
        if (!match) throw error;
        return {
          ok: false,
          output: message.slice(0, match.index),
          details: null,
          exitCode: Number(match[1]),
          error: message,
        };
      });
    };
  },
});
const __piStrings = (typeof globalThis["π"] === "object" && globalThis["π"] !== null) ? globalThis["π"] : {};
globalThis["π"] = new Proxy(__piStrings, {
  get(target, property) {
    if (typeof property === "symbol") return undefined;
    const name = String(property);
    if (name === "then" || name === "toJSON" || name === "constructor") return undefined;
    if (Object.prototype.hasOwnProperty.call(target, name)) return target[name];
    if (__piToolNames.indexOf(name) >= 0) {
      throw new Error(
        "π." + name + " is the strings accessor, not a tool. For the Pi core tool, call pi." + name + "(args)."
      );
    }
    const provided = Object.keys(target);
    throw new Error(
      "π." + name + " is not defined. π only exposes keys from the spindle_exec strings parameter" +
      (provided.length ? " (provided: " + provided.join(", ") + ")" : " (none provided)") +
      ". Pass strings: { " + name + ": '...' } to use π." + name + "."
    );
  },
  ownKeys(target) { return Reflect.ownKeys(target); },
  getOwnPropertyDescriptor(target, prop) { return Reflect.getOwnPropertyDescriptor(target, prop); },
  has(target, prop) { return Object.prototype.hasOwnProperty.call(target, prop); }
});
// Stable providers share a lazy dispatch proxy; the guest declarations keep
// their known actions typed while the registry remains the runtime authority.
const __providerProxy = (provider) => new Proxy({}, {
  get(_target, property) {
    if (property === "then" || typeof property === "symbol") return undefined;
    return (args = {}) => __call(provider + "." + String(property), args);
  },
});
globalThis.extensions = __providerProxy("extensions");
// tools is discovery + generic calls only. The proxy keeps the six discovery
// methods and turns a core-tool name (read/bash/edit/...) into an actionable
// error pointing at pi.<name>, so a model that writes tools.read(...) learns
// the fix in one turn instead of looping on "tools.read is not a function".
const __toolsBase = {
  providers: () => __call("spindle.$providers", {}),
  catalog: (args = {}) => __call("spindle.$catalog", args),
  list: (args = {}) => __call("spindle.$list", args),
  search: (args) => __call("spindle.$search", args),
  describe: (args) => __call("spindle.$describe", args),
  call: (args) => __call("spindle.$call", args),
};
globalThis.tools = new Proxy(__toolsBase, {
  get(target, property) {
    if (property === "then" || typeof property === "symbol") return undefined;
    const name = String(property);
    if (__piToolNames.indexOf(name) >= 0) {
      return () => {
        throw new Error(
          "tools." + name + " is not available on the discovery API. tools is discovery + generic calls only (providers/catalog/list/search/describe/call). For the Pi core tool, call pi." + name + "(args), e.g. pi." + name + "({ ... })."
        );
      };
    }
    return target[property];
  },
  set() { return true; },
  deleteProperty() { return true; },
});
globalThis.agents = Object.freeze({
  list: () => __call("agents.list", {}),
  run: (args) => __call("agents.run", args),
  runAll: (args) => __call("agents.runAll", Array.isArray(args) ? { tasks: args } : args),
  start: (args) => __call("agents.start", Array.isArray(args) ? { tasks: args } : args),
  wait: (args) => __call("agents.wait", typeof args === "string" ? { runId: args } : args),
  status: () => __call("agents.status", {}),
  cancel: (args) =>
    __call("agents.cancel", typeof args === "string" ? { runId: args } : (args || {})),
});
// One way in: mcp.call({ server, tool, args }), or the positional form
// mcp.call(server, tool, args). Every route lands on the pi-mcp-adapter
// gateway, which connects lazily.
//
// Discovery deliberately lives here rather than on tools.*: pi-mcp-adapter
// connects servers on demand, so an MCP tool list only exists after a gateway
// round-trip and cannot be folded into the static action registry without
// forcing every configured server to connect.
globalThis.mcp = Object.freeze({
  call: (serverName, tool, args) =>
    __call(
      "mcp.call",
      serverName && typeof serverName === "object"
        ? serverName
        : { server: serverName, tool, args: args ?? {} },
    ),
  list: (args = {}) => __call("mcp.list", typeof args === "string" ? { server: args } : args),
  search: (args) => __call("mcp.search", typeof args === "string" ? { query: args } : args),
  describe: (args) => __call("mcp.describe", typeof args === "string" ? { tool: args } : args),
  connect: (args) => __call("mcp.connect", typeof args === "string" ? { server: args } : args),
});
// The session-scoped scratchpad. τ = 2π, and the joke is load-bearing: π is
// this program's read-only payloads, τ is the store that outlives it. Methods
// rather than property access on purpose — every one of these can fail (bad
// key, non-serializable value, budget), and a failable write must not look
// like an assignment. The held keys are echoed in every spindle_exec result,
// so a later program does not have to guess what is there.
globalThis["τ"] = Object.freeze({
  get: async (key) => {
    const read = await __call("spindle.$stateGet", { key });
    return read && read.found ? read.value : undefined;
  },
  set: (key, value) => __call("spindle.$stateSet", { key, value }),
  keys: () => __call("spindle.$stateKeys", {}),
  delete: (key) => __call("spindle.$stateDelete", { key }),
  clear: () => __call("spindle.$stateClear", {}),
});
let __nextSpanId = 0;
// Captured before the Promise.all instrumentation below, so the worker pool
// and the wrapper never recurse through each other.
const __nativePromiseAll = Promise.all.bind(Promise);
const __withSpan = async (metadata, body) => {
  const id = "span-" + __nextSpanId++;
  await __call("spindle.$spanStart", { id, ...metadata });
  try {
    const value = await body(id);
    await __call("spindle.$spanEnd", { id, outcome: "succeeded" });
    return value;
  } catch (error) {
    try { await __call("spindle.$spanEnd", { id, outcome: "failed" }); } catch { /* preserve the original error */ }
    throw error;
  }
};
// Per-item progress is inferred, never declared. The runtime already knows
// each element's index, total and outcome, so nothing is asked of the program.
// Transitions are batched: a 200-item fan-out must not cost 400 host
// round-trips.
const __ITEM_MIN = 4;
const __ITEM_FLUSH_MAX = 32;
const __ITEM_FLUSH_MS = 120;
const __ITEM_LABEL_CHARS = 120;
const __itemLabelKeys = ["path", "file", "id", "name", "label", "ref", "url", "title"];
const __clipLabel = (value) =>
  value.length > __ITEM_LABEL_CHARS ? value.slice(0, __ITEM_LABEL_CHARS - 1) + "\u2026" : value;
// A fan-out over strings is usually a fan-out over paths or urls, which makes
// the element itself the most useful label. Objects expose the same thing under
// a conventional key. Anything else falls back to its position.
const __itemLabel = (value, index) => {
  if (typeof value === "string" && value.length > 0) return __clipLabel(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of __itemLabelKeys) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate.length > 0) return __clipLabel(candidate);
    }
  }
  return "#" + (index + 1);
};
const __createItemSink = (spanId, label, total) => {
  const pending = new Map();
  let timer = null;
  let closed = false;
  const flush = async () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (pending.size === 0) return;
    const items = [];
    for (const entry of pending.values()) items.push(entry);
    pending.clear();
    // Progress is best effort: a failed flush must never mask the program's
    // own outcome.
    try { await __call("spindle.$items", { items }); } catch { /* ignored */ }
  };
  const mark = (index, status) => {
    if (closed) return;
    pending.set(index, {
      id: spanId + "-" + index,
      label: label ? label(index) : "#" + (index + 1),
      status,
      kind: "task",
      total,
    });
    if (pending.size >= __ITEM_FLUSH_MAX) { void flush(); return; }
    if (timer === null) {
      timer = setTimeout(() => { timer = null; void flush(); }, __ITEM_FLUSH_MS);
    }
  };
  const close = async () => {
    await flush();
    closed = true;
  };
  return { mark, close };
};
const __runPool = async (thunks, options) => {
  if (!Array.isArray(thunks) || thunks.some((thunk) => typeof thunk !== "function")) {
    throw new TypeError("mapLimit expects an array of functions or (items, mapper)");
  }
  if (thunks.length === 0) return [];
  const concurrencyOpt = typeof options === "number" ? { concurrency: options } : options ?? {};
  const requestedConcurrency = Number(concurrencyOpt.concurrency ?? thunks.length);
  if (!Number.isFinite(requestedConcurrency) || requestedConcurrency < 1) {
    throw new RangeError("mapLimit concurrency must be a positive finite number");
  }
  const concurrency = Math.max(1, Math.min(thunks.length || 1, Math.floor(requestedConcurrency)));
  const results = new Array(thunks.length);
  const signal = concurrencyOpt.signal;
  if (signal && signal.aborted) throw __spindleAbortReason(signal);
  let cursor = 0;
  await __nativePromiseAll(Array.from({ length: concurrency }, async () => {
    while (cursor < thunks.length) {
      // Checked before each item rather than mid-flight: an aborted fan-out
      // stops launching new work, and the in-flight items cancel themselves if
      // they were handed the same signal.
      if (signal && signal.aborted) throw __spindleAbortReason(signal);
      const index = cursor++;
      results[index] = await thunks[index]();
    }
  }));
  return results;
};
// The one concurrency primitive Promise.all cannot express: Promise.all
// receives already-started promises, so it can never bound how many run at
// once. mapLimit takes thunks (or items + mapper) and starts them lazily
// behind a worker pool.
const __mapLimit = async (items, arg2, arg3) => {
  const mapper = typeof arg2 === "function" ? arg2 : undefined;
  const options = mapper ? arg3 : arg2;
  const itemCount = Array.isArray(items) ? items.length : undefined;
  let concurrency;
  if (itemCount !== undefined) {
    if (itemCount === 0) concurrency = 0;
    else {
      const opt = typeof options === "number" ? { concurrency: options } : options ?? {};
      const requested = Number(opt.concurrency ?? itemCount);
      if (Number.isFinite(requested) && requested >= 1) {
        concurrency = Math.max(1, Math.min(itemCount, Math.floor(requested)));
      }
    }
  }
  return __withSpan(
    {
      kind: "parallel",
      ...(itemCount !== undefined ? { itemCount } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
    },
    async (spanId) => {
      if (mapper && !Array.isArray(items)) {
        throw new TypeError("mapLimit expects an array as the first argument");
      }
      const thunks = mapper ? items.map((item, index) => () => mapper(item, index)) : items;
      if (itemCount === undefined || itemCount < __ITEM_MIN) return __runPool(thunks, options);
      const sink = __createItemSink(spanId, (index) => __itemLabel(mapper ? items[index] : undefined, index), itemCount);
      try {
        return await __runPool(
          thunks.map((thunk, index) => async () => {
            if (typeof thunk !== "function") {
              throw new TypeError("mapLimit expects an array of functions or (items, mapper)");
            }
            sink.mark(index, "running");
            try {
              const value = await thunk();
              sink.mark(index, "completed");
              return value;
            } catch (error) {
              sink.mark(index, "failed");
              throw error;
            }
          }),
          options,
        );
      } finally {
        await sink.close();
      }
    },
  );
};
globalThis.mapLimit = __mapLimit;
// Observability for the path the model actually uses. Promise.all cannot be
// capped (its inputs are already running by the time it is called), but its
// width is known at call time and each entry's outcome is observable, so a
// wide fan-out still reports progress. Narrow fan-outs skip the whole thing so
// the common two-call case pays no host round-trip. Entries have no labels
// here: an already-started promise carries nothing to name it with.
const __PROMISE_ALL_SPAN_MIN = __ITEM_MIN;
Promise.all = function all(values) {
  const list = Array.isArray(values) ? values : undefined;
  if (!list || list.length < __PROMISE_ALL_SPAN_MIN) return __nativePromiseAll(values);
  return __withSpan({ kind: "parallel", itemCount: list.length }, async (spanId) => {
    const sink = __createItemSink(spanId, null, list.length);
    for (let index = 0; index < list.length; index++) sink.mark(index, "running");
    const tracked = list.map((value, index) =>
      Promise.resolve(value).then(
        (resolved) => { sink.mark(index, "completed"); return resolved; },
        (error) => { sink.mark(index, "failed"); throw error; },
      ),
    );
    try {
      return await __nativePromiseAll(tracked);
    } finally {
      await sink.close();
    }
  });
};
globalThis.console = Object.freeze({ log: print, info: print, warn: print, error: print });
const __timerCallbacks = new Map();
let __nextTimerId = 1;
globalThis.setTimeout = (callback, ms = 0) => {
  const id = __nextTimerId++;
  __timerCallbacks.set(id, { callback, interval: false });
  __call("spindle.$timer", { ms }).then(() => {
    const entry = __timerCallbacks.get(id);
    if (!entry) return;
    __timerCallbacks.delete(id);
    try { entry.callback(); } catch { /* swallow timer callback errors */ }
  });
  return id;
};
globalThis.setInterval = (callback, ms = 0) => {
  const id = __nextTimerId++;
  __timerCallbacks.set(id, { callback, interval: true });
  const schedule = () => {
    __call("spindle.$timer", { ms }).then(() => {
      const entry = __timerCallbacks.get(id);
      if (!entry) return;
      try { entry.callback(); } catch { /* swallow timer callback errors */ }
      if (__timerCallbacks.has(id)) schedule();
    });
  };
  schedule();
  return id;
};
globalThis.clearTimeout = (id) => { __timerCallbacks.delete(id); };
globalThis.clearInterval = (id) => { __timerCallbacks.delete(id); };
})();
`;

const formatValue = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack ?? value.message;
	// QuickJS Error values arrive from context.dump() as plain objects holding
	// name/message/stack; render them like a real Error instead of raw JSON so
	// the failure text reads "Error: boom" plus frames, not an escaped blob.
	if (typeof value === "object" && value !== null) {
		const record = value as { name?: unknown; message?: unknown; stack?: unknown };
		if (typeof record.message === "string" && (typeof record.stack === "string" || typeof record.name === "string")) {
			const head = `${String(record.name)}: ${record.message}`;
			return typeof record.stack === "string" && record.stack.length > 0 ? `${head}\n${record.stack}` : head;
		}
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const jsonText = (value: unknown): string => {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return "null";
	return serialized;
};

const jsonHandle = (context: any, jsonObject: any, jsonParse: any, value: unknown): any => {
	if (value === undefined) return context.undefined;
	if (value === null) return context.null;
	if (typeof value === "string") return context.newString(value);
	if (typeof value === "boolean") return value ? context.true : context.false;
	if (typeof value === "number") {
		return Number.isFinite(value) ? context.newNumber(value) : context.null;
	}
	const serialized = context.newString(jsonText(value));
	try {
		return context.unwrapResult(context.callFunction(jsonParse, jsonObject, serialized));
	} finally {
		serialized.dispose();
	}
};

const HOST_TASK_SETTLE_GRACE_MS = 250;

/**
 * QuickJS call-stack ceiling for a guest program. Without it a deeply recursive
 * program exhausts the host stack instead of raising a guest RangeError.
 */
const QUICKJS_MAX_STACK_SIZE_BYTES = 256 * 1024;

export class QuickJsRuntime {
	async execute(
		code: string,
		hostCall: SpindleHostCall,
		options: SpindleSandboxOptions,
	): Promise<SpindleSandboxResult> {
		if (options.signal?.aborted) {
			return {
				value: undefined,
				logs: [],
				terminationReason: "aborted",
				error: "Execution cancelled",
			};
		}
		if (
			!Number.isSafeInteger(options.memoryLimitBytes) ||
			options.memoryLimitBytes < 1 ||
			options.memoryLimitBytes > 0xffff_ffff
		) {
			return {
				value: undefined,
				logs: [],
				terminationReason: "runtime_error",
				error: "QuickJS memory limit must be an integer between 1 byte and 4294967295 bytes (WASM32 maximum)",
			};
		}
		const module = await quickJsModule();
		const context = module.newContext();
		const runtime = context.runtime;
		const jsonObject = context.getProp(context.global, "JSON");
		const jsonParse = context.getProp(jsonObject, "parse");
		const executionStartedAt = Date.now();
		let effectiveTimeoutMs = options.timeoutMs;
		let executionDeadlineAt = executionStartedAt + effectiveTimeoutMs;
		let interruptedByDeadline = false;
		runtime.setMemoryLimit(options.memoryLimitBytes);
		// Runaway guest recursion otherwise walks the host stack until the process
		// crashes; a bounded QuickJS stack turns it into a catchable guest error.
		runtime.setMaxStackSize(QUICKJS_MAX_STACK_SIZE_BYTES);
		runtime.setInterruptHandler(() => {
			if (options.signal?.aborted === true) return true;
			if (Date.now() <= executionDeadlineAt) return false;
			interruptedByDeadline = true;
			return true;
		});
		const logs: string[] = [];
		const maxLogChars = options.maxLogChars ?? 100_000;
		let logChars = 0;
		let logsTruncated = false;
		const pendingHostPromises = new Set<any>();
		const hostTasks = new Set<Promise<void>>();
		const pendingTimers = new Set<NodeJS.Timeout>();
		let closing = false;
		let cancelled = false;
		let timedOut = false;
		let timeout: NodeJS.Timeout | undefined;
		let rejectDeadline: ((error: Error) => void) | undefined;
		let abortHandler: (() => void) | undefined;
		let activePromiseHandle: any;
		let executionGate: any;
		let pendingResolution: Promise<any> | undefined;
		const hostAbortController = new AbortController();
		const abortHostCalls = (reason: string): void => {
			if (!hostAbortController.signal.aborted) {
				hostAbortController.abort(new Error(reason));
			}
		};

		const rejectExecutionGate = (message: string): void => {
			if (!executionGate || executionGate.alive === false) return;
			const errorHandle = context.newError(message);
			executionGate.reject(errorHandle);
			errorHandle.dispose();
			runtime.executePendingJobs();
		};

		const timeoutMessage = (): string => `Execution timed out after ${effectiveTimeoutMs}ms`;
		const expireDeadline = (): void => {
			if (closing || cancelled || timedOut) return;
			timedOut = true;
			const message = timeoutMessage();
			abortHostCalls(message);
			rejectExecutionGate(message);
			rejectDeadline?.(new Error(message));
		};
		const scheduleDeadline = (): void => {
			if (!rejectDeadline || closing || cancelled || timedOut) return;
			if (timeout) clearTimeout(timeout);
			timeout = setTimeout(expireDeadline, Math.max(0, executionDeadlineAt - Date.now()));
		};
		const extendExecutionTimeout = (ref: string, args: Record<string, unknown>): void => {
			const requestedTimeoutMs = options.minimumTimeoutMsForHostCall?.(ref, args);
			if (typeof requestedTimeoutMs !== "number" || !Number.isFinite(requestedTimeoutMs)) {
				return;
			}
			const requestedDurationMs = Math.max(1, Math.floor(requestedTimeoutMs));
			const nextDeadlineAt = Date.now() + requestedDurationMs;
			const nextTimeoutMs = nextDeadlineAt - executionStartedAt;
			if (nextDeadlineAt <= executionDeadlineAt) return;
			effectiveTimeoutMs = nextTimeoutMs;
			executionDeadlineAt = nextDeadlineAt;
			scheduleDeadline();
		};

		/**
		 * In-flight host calls the guest may cancel, keyed by the id the guest
		 * generated. Only calls that carried a signal appear here.
		 */
		const callControllers = new Map<number, AbortController>();

		try {
			const hostFunction = context.newFunction("__spindleHostCall", (referenceHandle: any, argsHandle: any) => {
				const reference = context.getString(referenceHandle);
				const dumpedArgs = context.dump(argsHandle);
				const args =
					typeof dumpedArgs === "object" && dumpedArgs !== null && !Array.isArray(dumpedArgs)
						? (dumpedArgs as Record<string, unknown>)
						: {};
				const callIdValue = args.__spindleCallId;
				const callId = typeof callIdValue === "number" ? callIdValue : undefined;
				if (callId !== undefined) delete args.__spindleCallId;
				extendExecutionTimeout(reference, args);
				const promise = context.newPromise();
				pendingHostPromises.add(promise);
				void promise.settled.then(() => pendingHostPromises.delete(promise));
				if (reference === "spindle.$timer") {
					const ms = Math.max(0, Number(args.ms ?? 0));
					const timer = setTimeout(() => {
						if (closing || promise.alive === false) return;
						promise.resolve(context.undefined);
						runtime.executePendingJobs();
					}, ms);
					timer.unref?.();
					pendingTimers.add(timer);
					void promise.settled.then(() => pendingTimers.delete(timer));
					return promise.handle;
				}
				// Guest-initiated cancellation of one in-flight call. Resolved through a
				// zero-delay timer for the same reason spindle.$timer is: settling a
				// promise from inside newFunction needs a pending-jobs pump afterwards.
				if (reference === "spindle.$cancel") {
					callControllers.get(Number(args.callId))?.abort(new Error("The host call was cancelled by the guest"));
					const timer = setTimeout(() => {
						if (closing || promise.alive === false) return;
						promise.resolve(context.undefined);
						runtime.executePendingJobs();
					}, 0);
					timer.unref?.();
					pendingTimers.add(timer);
					void promise.settled.then(() => pendingTimers.delete(timer));
					return promise.handle;
				}
				// A cancellable call gets its own controller, chained to the
				// program-wide one so a deadline or an outer abort still reaches it.
				let callSignal = hostAbortController.signal;
				if (callId !== undefined) {
					const controller = new AbortController();
					const onProgramAbort = (): void => controller.abort(hostAbortController.signal.reason);
					if (hostAbortController.signal.aborted) onProgramAbort();
					else hostAbortController.signal.addEventListener("abort", onProgramAbort, { once: true });
					callControllers.set(callId, controller);
					callSignal = controller.signal;
					void promise.settled.then(() => {
						callControllers.delete(callId);
						hostAbortController.signal.removeEventListener("abort", onProgramAbort);
					});
				}
				const task = runAbortable(callSignal, () => hostCall(reference, args, callSignal))
					.then((value) => {
						if (closing || promise.alive === false) return;
						const handle = jsonHandle(context, jsonObject, jsonParse, value);
						promise.resolve(handle);
						handle.dispose();
					})
					.catch((error) => {
						if (closing || promise.alive === false) return;
						const errorHandle = context.newError(error instanceof Error ? error.message : String(error));
						// A classified bash exit crosses as structured metadata so the guest
						// settle envelope never depends on the rendered error text.
						const exit = reference === "pi.bash" ? piBashExitMetadata(error) : undefined;
						if (exit) {
							const metadata = jsonHandle(context, jsonObject, jsonParse, exit);
							context.setProp(errorHandle, "__spindleBashExit", metadata);
							metadata.dispose();
						}
						promise.reject(errorHandle);
						errorHandle.dispose();
					})
					.finally(() => {
						if (!closing) runtime.executePendingJobs();
					});
				hostTasks.add(task);
				void task.finally(() => hostTasks.delete(task));
				return promise.handle;
			});
			context.setProp(context.global, "__spindleHostCall", hostFunction);
			hostFunction.dispose();

			const printFunction = context.newFunction("print", (...handles: any[]) => {
				if (logsTruncated) return;
				const line = handles.map((handle) => formatValue(context.dump(handle))).join(" ");
				const remaining = maxLogChars - logChars;
				if (line.length > remaining) {
					if (remaining > 0) logs.push(line.slice(0, remaining));
					logs.push("[Pi Spindle log output truncated]");
					logsTruncated = true;
					return;
				}
				logs.push(line);
				logChars += line.length;
			});
			context.setProp(context.global, "print", printFunction);
			printFunction.dispose();

			const strings = jsonHandle(context, jsonObject, jsonParse, options.strings ?? {});
			context.setProp(context.global, "π", strings);
			strings.dispose();

			const processInfo = jsonHandle(
				context,
				jsonObject,
				jsonParse,
				options.process ?? { env: {}, platform: "unknown", arch: "unknown", cwd: "" },
			);
			context.setProp(context.global, "__spindleProcess", processInfo);
			processInfo.dispose();

			// The polyfill layer is selected from the program text and evaluated as
			// part of setup, so a program that never mentions URL never pays to
			// parse a URL parser (newContext() runs per execute() call).
			const polyfills =
				options.polyfills === false ? { source: "", names: [], needsEntropy: false } : guestPolyfillPlan(code);
			if (polyfills.needsEntropy) {
				// crypto.getRandomValues must be synchronous and every host call here
				// is async, so real entropy is injected up front rather than fetched
				// on demand. The guest deletes the global as it reads it.
				const entropy = context.newString(randomBytes(ENTROPY_POOL_BYTES).toString("hex"));
				context.setProp(context.global, "__spindleEntropy", entropy);
				entropy.dispose();
			}
			const setupResult = context.evalCode(GUEST_SETUP + polyfills.source, "spindle-setup.js");
			if (setupResult.error) {
				const deadlineExceeded = interruptedByDeadline || Date.now() > executionDeadlineAt;
				if (deadlineExceeded) timedOut = true;
				const error = options.signal?.aborted
					? "Execution cancelled"
					: deadlineExceeded
						? timeoutMessage()
						: formatValue(context.dump(setupResult.error));
				setupResult.error.dispose();
				abortHostCalls(error);
				return {
					value: undefined,
					logs,
					terminationReason: options.signal?.aborted
						? "aborted"
						: deadlineExceeded
							? "timed_out"
							: "runtime_error",
					error,
				};
			}
			setupResult.value.dispose();

			executionGate = context.newPromise();
			context.setProp(context.global, "__spindleExecutionGate", executionGate.handle);
			// When the caller supplies the transpiled code it must supply its map
			// too (a self-transpiled map would not match); otherwise transpile here
			// and keep the emitted map for error-position translation.
			let sourceMap: GuestSourceMap | undefined;
			let guestProgram: string;
			if (options.transpiledCode !== undefined) {
				guestProgram = options.transpiledCode;
				sourceMap = parseGuestSourceMap(options.sourceMap);
			} else {
				const transpiled = transpileSpindleCode(code);
				guestProgram = transpiled.javascript;
				sourceMap = parseGuestSourceMap(options.sourceMap ?? transpiled.sourceMap);
			}
			// Guest stack frames point into the emitted JS; rewrite them to the
			// user's program coordinates so the reported line is the line written.
			const formatGuestError = (handle: any): string =>
				mapGuestErrorText(formatValue(context.dump(handle)), sourceMap);
			const wrappedCode = `${guestProgram}\nPromise.race([__piSpindleMain(), globalThis.__spindleExecutionGate])`;
			const evaluation = context.evalCode(wrappedCode, "pi-spindle-guest.js");
			runtime.executePendingJobs();
			if (evaluation.error) {
				const deadlineExceeded = interruptedByDeadline || Date.now() > executionDeadlineAt;
				if (deadlineExceeded) timedOut = true;
				const error = options.signal?.aborted
					? "Execution cancelled"
					: deadlineExceeded
						? timeoutMessage()
						: formatGuestError(evaluation.error);
				evaluation.error.dispose();
				abortHostCalls(error);
				return {
					value: undefined,
					logs,
					terminationReason: options.signal?.aborted
						? "aborted"
						: deadlineExceeded
							? "timed_out"
							: "runtime_error",
					error,
				};
			}

			activePromiseHandle = evaluation.value;
			const cancellation = new Promise<never>((_resolve, reject) => {
				abortHandler = () => {
					cancelled = true;
					hostAbortController.abort(options.signal?.reason);
					rejectExecutionGate("Execution cancelled");
					reject(new Error("Execution cancelled"));
				};
				if (options.signal?.aborted) abortHandler();
				else options.signal?.addEventListener("abort", abortHandler, { once: true });
			});
			void cancellation.catch(() => undefined);
			const deadline = new Promise<never>((_resolve, reject) => {
				rejectDeadline = reject;
				scheduleDeadline();
			});
			pendingResolution = context.resolvePromise(activePromiseHandle);
			runtime.executePendingJobs();
			const resolution = await Promise.race([pendingResolution, deadline, cancellation]);
			pendingResolution = undefined;
			activePromiseHandle.dispose();
			activePromiseHandle = undefined;
			if (resolution.error) {
				const deadlineExceeded = timedOut || interruptedByDeadline || Date.now() > executionDeadlineAt;
				if (deadlineExceeded) timedOut = true;
				const error = options.signal?.aborted
					? "Execution cancelled"
					: deadlineExceeded
						? timeoutMessage()
						: formatGuestError(resolution.error);
				resolution.error.dispose();
				abortHostCalls(error);
				return {
					value: undefined,
					logs,
					terminationReason: options.signal?.aborted
						? "aborted"
						: deadlineExceeded
							? "timed_out"
							: "runtime_error",
					error,
				};
			}
			const value = context.dump(resolution.value);
			resolution.value.dispose();
			return { value, logs, terminationReason: "completed" };
		} catch (error) {
			const deadlineExceeded = timedOut || interruptedByDeadline || Date.now() > executionDeadlineAt;
			if (deadlineExceeded) timedOut = true;
			abortHostCalls(error instanceof Error ? error.message : String(error));
			return {
				value: undefined,
				logs,
				terminationReason: cancelled ? "aborted" : deadlineExceeded ? "timed_out" : "runtime_error",
				error: cancelled
					? "Execution cancelled"
					: deadlineExceeded
						? timeoutMessage()
						: error instanceof Error
							? error.message
							: String(error),
			};
		} finally {
			if (timeout) clearTimeout(timeout);
			for (const timer of pendingTimers) clearTimeout(timer);
			if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
			if (hostTasks.size > 0) {
				const settled = await settleWithin(hostTasks, HOST_TASK_SETTLE_GRACE_MS);
				if (!settled) {
					abortHostCalls("Spindle guest execution ended before its host calls settled");
					await settleWithin(hostTasks, HOST_TASK_SETTLE_GRACE_MS);
				}
				runtime.executePendingJobs();
			}
			closing = true;
			if (timedOut || cancelled || pendingHostPromises.size > 0) {
				const cleanupMessage = cancelled
					? "Execution cancelled"
					: timedOut
						? timeoutMessage()
						: "Spindle guest execution ended before its host calls settled";
				if (!hostAbortController.signal.aborted) hostAbortController.abort(new Error(cleanupMessage));
				rejectExecutionGate(cleanupMessage);
				const errorHandle = context.newError(cleanupMessage);
				for (const promise of pendingHostPromises) promise.reject(errorHandle);
				errorHandle.dispose();
				runtime.executePendingJobs();
				await new Promise((resolve) => setImmediate(resolve));
				const settled = await Promise.race<any>([
					pendingResolution ? pendingResolution.catch(() => undefined) : Promise.resolve(undefined),
					new Promise<undefined>((resolve) => {
						const timer = setTimeout(() => resolve(undefined), 1_000);
						timer.unref?.();
					}),
				]);
				if (settled?.error) settled.error.dispose();
				if (settled?.value) settled.value.dispose();
				for (const promise of pendingHostPromises) {
					if (promise.alive !== false) promise.dispose();
				}
			}
			if (activePromiseHandle?.alive !== false) activePromiseHandle?.dispose();
			if (executionGate?.alive !== false) executionGate?.dispose();
			runtime.executePendingJobs();
			jsonParse.dispose();
			jsonObject.dispose();
			context.dispose();
		}
	}
}
