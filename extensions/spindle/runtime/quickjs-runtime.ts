import releaseSyncVariant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { runAbortable, settleWithin } from "../async-settlement.ts";
import { transpileSpindleCode } from "./type-checker.ts";

export type SpindleSandboxTerminationReason =
  | "completed"
  | "runtime_error"
  | "timed_out"
  | "aborted";

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
  /** Injected as the guest's `process` global; the host filters the env allowlist. */
  process?: {
    env: Record<string, string>;
    platform: string;
    arch: string;
    cwd: string;
  };
  signal?: AbortSignal;
  minimumTimeoutMsForHostCall?(
    ref: string,
    args: Record<string, unknown>,
  ): number | undefined;
  transpiledCode?: string;
}

export type SpindleHostCall = (
  ref: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

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
const __call = async (ref, args) => __spindleBridge(ref, args ?? {});
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
        const message = error instanceof Error ? error.message : String(error);
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
});
// mcp.<server>.<tool>(args) is pure sugar for mcp.call({ server, tool, args });
// every route lands on the pi-mcp-adapter gateway, which connects lazily.
globalThis.mcp = new Proxy({}, {
  get(_target, server) {
    if (server === "then") return undefined;
    if (server === "list") {
      return (args = {}) => __call("mcp.$list", typeof args === "string" ? { server: args } : args);
    }
    if (server === "connect") {
      return (args) => __call("mcp.$connect", typeof args === "string" ? { server: args } : args);
    }
    if (server === "search") {
      return (args) => __call("mcp.$search", typeof args === "string" ? { query: args } : args);
    }
    if (server === "describe") {
      return (args) => __call("mcp.$describe", typeof args === "string" ? { tool: args } : args);
    }
    if (server === "call") {
      return (serverName, tool, args) =>
        __call(
          "mcp.$call",
          serverName && typeof serverName === "object"
            ? serverName
            : { server: serverName, tool, args: args ?? {} },
        );
    }
    // Calling the server proxy itself (mcp.<server>()) lists that server's
    // tools, matching the natural "inspect a server" guess; property access
    // stays sugar for mcp.call({ server, tool, args }).
    return new Proxy(function () {}, {
      apply() {
        return __call("mcp.$list", { server: String(server) });
      },
      get(_serverTarget, tool) {
        if (tool === "then") return undefined;
        return (args = {}) =>
          __call("mcp.$call", { server: String(server), tool: String(tool), args });
      },
    });
  },
});
let __nextWorkflowSpanId = 0;
const __workflowSpanMetadata = (kind, items, options, stageCount) => {
  const itemCount = Array.isArray(items) ? items.length : undefined;
  let concurrency;
  if (kind === "parallel" && itemCount !== undefined) {
    if (itemCount === 0) concurrency = 0;
    else {
      const concurrencyOpt = typeof options === "number" ? { concurrency: options } : options ?? {};
      const requested = Number(concurrencyOpt.concurrency ?? itemCount);
      if (Number.isFinite(requested) && requested >= 1) {
        concurrency = Math.max(1, Math.min(itemCount, Math.floor(requested)));
      }
    }
  }
  return {
    kind,
    ...(itemCount !== undefined ? { itemCount } : {}),
    ...(stageCount !== undefined ? { stageCount } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
  };
};
const __withWorkflowSpan = async (metadata, body) => {
  const id = "span-" + __nextWorkflowSpanId++;
  await __call("spindle.$spanStart", { id, ...metadata });
  try {
    const value = await body();
    await __call("spindle.$spanEnd", { id, outcome: "succeeded" });
    return value;
  } catch (error) {
    try { await __call("spindle.$spanEnd", { id, outcome: "failed" }); } catch { /* preserve the workflow error */ }
    throw error;
  }
};
const __runParallel = async (thunks, options) => {
  if (!Array.isArray(thunks) || thunks.some((thunk) => typeof thunk !== "function")) {
    throw new TypeError("workflow.parallel expects an array of functions or (items, mapper)");
  }
  if (thunks.length === 0) return [];
  const concurrencyOpt = typeof options === "number" ? { concurrency: options } : options ?? {};
  const requestedConcurrency = Number(concurrencyOpt.concurrency ?? thunks.length);
  if (!Number.isFinite(requestedConcurrency) || requestedConcurrency < 1) {
    throw new RangeError("workflow.parallel concurrency must be a positive finite number");
  }
  const concurrency = Math.max(1, Math.min(thunks.length || 1, Math.floor(requestedConcurrency)));
  const results = new Array(thunks.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < thunks.length) {
      const index = cursor++;
      results[index] = await thunks[index]();
    }
  }));
  return results;
};
const __workflowParallel = async (items, arg2, arg3) => {
  const options = typeof arg2 === "function" ? arg3 : arg2;
  return __withWorkflowSpan(
    __workflowSpanMetadata("parallel", items, options),
    async () => {
      if (typeof arg2 === "function") {
        if (!Array.isArray(items)) throw new TypeError("workflow.parallel expects an array as the first argument");
        return __runParallel(items.map((item, index) => () => arg2(item, index)), arg3);
      }
      return __runParallel(items, arg2);
    },
  );
};
const __workflowPipeline = async (items, ...stages) =>
  __withWorkflowSpan(
    __workflowSpanMetadata("pipeline", items, undefined, stages.length),
    async () => {
      if (!Array.isArray(items) || stages.some((stage) => typeof stage !== "function")) {
        throw new TypeError("workflow.pipeline expects an array followed by stage functions");
      }
      return __workflowParallel(items.map((original, index) => async () => {
        let value = original;
        for (const stage of stages) value = await stage(value, original, index);
        return value;
      }));
    },
  );
globalThis.workflow = Object.freeze({
  parallel: __workflowParallel,
  pipeline: __workflowPipeline,
  configure: (args) => __call("spindle.$configure", args),
  phase: (nameOrInput, options = {}) => {
    const input =
      nameOrInput && typeof nameOrInput === "object" && !Array.isArray(nameOrInput)
        ? { ...nameOrInput }
        : { ...options, name: nameOrInput };
    return __call("spindle.$phase", input);
  },
  item: (args) => __call("spindle.$item", args),
  event: (args) => __call("spindle.$event", args),
  log: (...values) => print(...values),
});
globalThis.parallel = __workflowParallel;
globalThis.pipeline = __workflowPipeline;
globalThis.phase = workflow.phase;
globalThis.log = workflow.log;
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

const jsonHandle = (
  context: any,
  jsonObject: any,
  jsonParse: any,
  value: unknown,
): any => {
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

    const timeoutMessage = (): string =>
      `Execution timed out after ${effectiveTimeoutMs}ms`;
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
    const extendExecutionTimeout = (
      ref: string,
      args: Record<string, unknown>,
    ): void => {
      const requestedTimeoutMs = options.minimumTimeoutMsForHostCall?.(ref, args);
      if (
        typeof requestedTimeoutMs !== "number" ||
        !Number.isFinite(requestedTimeoutMs)
      ) {
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

    try {
      const hostFunction = context.newFunction(
        "__spindleHostCall",
        (referenceHandle: any, argsHandle: any) => {
          const reference = context.getString(referenceHandle);
          const dumpedArgs = context.dump(argsHandle);
          const args =
            typeof dumpedArgs === "object" && dumpedArgs !== null && !Array.isArray(dumpedArgs)
              ? (dumpedArgs as Record<string, unknown>)
              : {};
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
          const task = runAbortable(hostAbortController.signal, () =>
            hostCall(reference, args, hostAbortController.signal),
          )
            .then((value) => {
              if (closing || promise.alive === false) return;
              const handle = jsonHandle(context, jsonObject, jsonParse, value);
              promise.resolve(handle);
              handle.dispose();
            })
            .catch((error) => {
              if (closing || promise.alive === false) return;
              const errorHandle = context.newError(
                error instanceof Error ? error.message : String(error),
              );
              promise.reject(errorHandle);
              errorHandle.dispose();
            })
            .finally(() => {
              if (!closing) runtime.executePendingJobs();
            });
          hostTasks.add(task);
          void task.finally(() => hostTasks.delete(task));
          return promise.handle;
        },
      );
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

      const setupResult = context.evalCode(GUEST_SETUP, "spindle-setup.js");
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
      const guestProgram = options.transpiledCode ?? transpileSpindleCode(code);
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
            : formatValue(context.dump(evaluation.error));
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
            : formatValue(context.dump(resolution.error));
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
