/**
 * TRIMMED from upstream `src/runtime/guest-types.ts`.
 *
 * These declarations are what the sandboxed TypeScript is type-checked
 * against, so they must match `GUEST_SETUP` in `quickjs-runtime.ts` exactly.
 * Every dropped global (`tools`, `mesh`, `memory`, `state`, `schema`,
 * `compact`, `council`, `rlm`, `agent`, `budget`) is gone from both.
 *
 * A subagent's tool allowlist (see `core/tool-allowlist.ts`) is applied on top:
 * disallowed `pi.*` members are removed from `PiToolsApi` so the declared
 * schema matches what the sandbox may actually call. Note this is schema
 * shaping, not enforcement: `type-checker.ts` filters out TS2339 and friends
 * (see `TYPE_CORRECTNESS_CODES`), so the rejection itself comes from the
 * providers at call time.
 */
import type { SpindleDynamicGuestDeclarations } from "../protocol.ts";

export const GUEST_TYPE_DECLARATIONS = `
// Engine features past the declared \`lib\` tier (see runtime/type-checker.ts).
// The pinned engine implements Error.isError, which TypeScript ships only in
// lib.esnext.error; the rest of what it has beyond es2025 is nothing we want to
// promise. Keep this block in step with runtime/guest-baseline.test.ts.
interface ErrorConstructor {
  isError(value: unknown): value is Error;
}
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
interface SpindleCapturedToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  text: string;
  details?: unknown;
  isError: boolean;
  terminate?: boolean;
  source: { path: string; source: string; scope: string; origin: string; baseDir?: string };
}
interface SpindleCapturedTool {
  (args?: Record<string, unknown>): Promise<SpindleCapturedToolResult>;
}
type SpindleExtensionsApi = Record<string, SpindleCapturedTool>;
interface SpindleAction {
  ref: string;
  provider: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  namespace?: string;
}
interface SpindleCapabilityActionHead {
  key: string;
  parentKey: string;
  ref: string;
  name: string;
  description: string;
  descriptorHash: string;
  namespace?: string;
}
interface SpindleCapabilityProviderHead {
  key: string;
  parentKey: string;
  name: string;
  description: string;
  descriptorHash: string;
  actions: SpindleCapabilityActionHead[];
}
interface SpindleCapabilityCatalog {
  kind: "pi-spindle.capability-catalog";
  version: 1;
  root: { key: "capability:spindle"; name: "Spindle capabilities"; description: string; descriptorHash: string };
  providers: SpindleCapabilityProviderHead[];
  totalActions: number;
  indexedActions: number;
  complete: boolean;
  reasons: string[];
}
// tools is discovery + generic dispatch across every provider (pi, extensions,
// mcp, agents). It owns no tools: use it to enumerate/describe actions or call
// a ref computed at runtime. Direct named calls stay on their own namespace
// (extensions.<tool>(), pi.<tool>(), mcp.<server>.<tool>()).
interface SpindleToolsApi {
  providers(): Promise<Array<{ name: string; description: string }>>;
  catalog(args?: { provider?: string; limit?: number }): Promise<SpindleCapabilityCatalog>;
  list(args?: { provider?: string; namespace?: string; query?: string; limit?: number }): Promise<SpindleAction[]>;
  search(args: { query: string; limit?: number }): Promise<SpindleAction[]>;
  describe(args: { ref: string }): Promise<SpindleAction>;
  call(args: { ref: string; args?: Record<string, unknown> }): Promise<unknown>;
}
// NOTE: these declarations are compiler input, not prompt text. They are read
// only by runtime/type-checker.ts and runtime/core-tool-properties.ts, and are
// never sent to the model, so breadth here is free and costs no tokens. The
// canonical, model-facing statement of the return-shape rule and the one
// taught spelling per tool lives in FULL_CODE_GUIDANCE in index.ts. Keep the
// unions here wide (every alias arg-normalization accepts) so an accepted call
// never fails type checking; keep the guidance there narrow.
// String-primary tools (read/bash/grep/find/ls) accept a bare string; the
// runtime proxy coerces it to { <primaryField>: string }. Lets the model write
// the natural form (pi.bash("ls")) instead of pi.bash({ command: "ls" }).
// Return shapes differ by tool: read/grep/find/ls return their text as a bare
// string (e.g. const src: string = await pi.read({ path })); bash/edit/write
// return { ok, output, details } (e.g. const { output } = await pi.bash(...)).
// Common alias keys (cmd→command, query→pattern, file→path, dir→path) and a
// flat edit shape ({ path, oldText, newText }) are also accepted; the runtime
// proxy normalizes them to the canonical form before the host validates args.
// Bash timeout is measured in seconds; timeoutMs is converted from milliseconds.
// Per-call pi.bash extras: cwd (absolute working directory; workdir /
// workingDir / workingDirectory are normalized aliases), env (extra variables
// merged over the shell environment), and stdin (text piped to the command,
// e.g. pi.bash({ command: 'ssh host bash -s', stdin: π.script })).
type SpindleBashOptions = {
  /** Cancels this command. See AbortController. */
  signal?: AbortSignal;
  timeout?: number;
  timeoutMs?: number;
  settle?: boolean;
  cwd?: string;
  workdir?: string;
  workingDir?: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  stdin?: string;
};
interface PiToolsApi {
  read(args: string | { path: string; offset?: number; limit?: number; start?: number; max?: number } | { file: string; offset?: number; limit?: number; start?: number; max?: number }): Promise<string>;
  bash(args: string | (({ command: string } | { cmd: string } | { shell: string }) & SpindleBashOptions)): Promise<{ ok: true; output: string; details: unknown } | { ok: false; output: string; details: null; exitCode: number; error: string }>;
  edit(args: { path: string; edits: Array<{ oldText: string; newText: string }> } | { file: string; edits: Array<{ oldText: string; newText: string }> } | { path: string; oldText: string; newText: string } | { file: string; oldText: string; newText: string } | { path: string; old: string; new: string } | { path: string; old: string; replacement: string }): Promise<{ ok: true; output: string; details: unknown }>;
  edit(path: string, oldText: string, newText: string): Promise<{ ok: true; output: string; details: unknown }>;
  write(args: { path: string; content: string } | { file: string; content: string } | { path: string; contents: string } | { path: string; body: string } | { path: string; text: string }): Promise<{ ok: true; output: string; details: unknown }>;
  write(path: string, content: string): Promise<{ ok: true; output: string; details: unknown }>;
  grep(args: string | { pattern: string; path?: string; glob?: string; globPattern?: string; ignoreCase?: boolean; ic?: boolean; caseInsensitive?: boolean; literal?: boolean; context?: number; ctx?: number; limit?: number; max?: number } | { query: string; path?: string; glob?: string; globPattern?: string; ignoreCase?: boolean; ic?: boolean; caseInsensitive?: boolean; literal?: boolean; context?: number; ctx?: number; limit?: number; max?: number } | { regex: string; path?: string; glob?: string; globPattern?: string; ignoreCase?: boolean; ic?: boolean; caseInsensitive?: boolean; literal?: boolean; context?: number; ctx?: number; limit?: number; max?: number } | { search: string; path?: string; glob?: string; globPattern?: string; ignoreCase?: boolean; ic?: boolean; caseInsensitive?: boolean; literal?: boolean; context?: number; ctx?: number; limit?: number; max?: number }): Promise<string>;
  grep(pattern: string, path?: string, limit?: number): Promise<string>;
  find(args: string | { pattern: string; path?: string; limit?: number; max?: number } | { query: string; path?: string; limit?: number; max?: number } | { regex: string; path?: string; limit?: number; max?: number } | { search: string; path?: string; limit?: number; max?: number }): Promise<string>;
  find(pattern: string, path?: string, limit?: number): Promise<string>;
  ls(args?: string | { path?: string; limit?: number; max?: number } | { dir?: string; limit?: number; max?: number } | { file?: string; limit?: number; max?: number }): Promise<string>;
}
interface SpindleAgentDefinition {
  name: string;
  scope: "project" | "user";
  description?: string;
}
interface SpindleAgentRequest {
  /** Name of a discovered agent (see agents.list()). */
  agent: string;
  task: string;
  model?: string;
  thinking?: string;
  /** Persist this run's submitted result at this path instead of the run dir. */
  output?: string;
  /** Files the agent should read first for context. */
  reads?: string[];
  /** Inherit the night-mode contract when an overnight run is in flight. */
  night?: boolean;
}
/**
 * Timing is per batch, not per task: waitMs bounds how long the caller blocks,
 * timeoutMs how long the children may live (clamped to the configured cap).
 */
interface SpindleAgentBatchTiming {
  /** Cancels the batch. See AbortController. */
  signal?: AbortSignal;
  /**
   * How long to block before handing back a running handle (default: the
   * configured wait window). 0 returns as soon as the run is launched. An
   * expired wait is not a failure: the run continues in the background.
   */
  waitMs?: number;
  /** Hard cap on the children's own lifetime; past it they are killed. */
  timeoutMs?: number;
}
interface SpindleAgentResult {
  agent: string;
  ok: boolean;
  output: string;
  /**
   * "running" means the wait window expired and the child is still working; it
   * is not a failure. Poll agents.wait({ runId }) or let the result arrive as a
   * follow-up message.
   */
  state: "done" | "failed" | "running";
  /** Handle for agents.wait / agents.cancel. */
  runId: string;
  /** Where the result was persisted. Absent when nothing landed on disk. */
  outputPath?: string;
  exitCode?: number;
  paneId?: string;
  error?: string;
}
interface SpindleAgentHandle {
  runId: string;
  agents: string[];
  state: "running";
}
interface SpindleAgentWait {
  runId: string;
  state: "running" | "settled" | "cancelled";
  elapsedMs: number;
  agents: string[];
  results: SpindleAgentResult[];
}
interface SpindleAgentStatus {
  runId: string;
  agents: string[];
  state: "running" | "settled" | "cancelled";
  startedAt: number;
  elapsedMs: number;
  /** True once no caller is blocked on it and it kept running. */
  detached: boolean;
  results?: SpindleAgentResult[];
}
interface SpindleAgentsApi {
  list(): Promise<SpindleAgentDefinition[]>;
  run(args: SpindleAgentRequest & SpindleAgentBatchTiming): Promise<SpindleAgentResult>;
  runAll(args: { tasks: SpindleAgentRequest[] } & SpindleAgentBatchTiming | SpindleAgentRequest[]): Promise<SpindleAgentResult[]>;
  /** Launch without blocking; the run is not tied to this turn. */
  start(args: (SpindleAgentRequest & { timeoutMs?: number }) | ({ tasks: SpindleAgentRequest[] } & { timeoutMs?: number }) | SpindleAgentRequest[]): Promise<SpindleAgentHandle>;
  /** Resume waiting on a launched batch. */
  wait(args: string | { runId: string; waitMs?: number }): Promise<SpindleAgentWait>;
  /** Live and recently finished batches. */
  status(): Promise<SpindleAgentStatus[]>;
  /** Cancel one batch, or every live batch when runId is omitted. */
  cancel(args?: string | { runId?: string }): Promise<{ cancelled: string[] }>;
}
interface SpindleMcpResult {
  text: string;
  content: unknown[];
  structuredContent: unknown;
}
type SpindleMcpApi = {
  call(server: string, tool: string, args?: Record<string, unknown>): Promise<SpindleMcpResult | unknown>;
  call(args: { server?: string; tool: string; args?: Record<string, unknown> }): Promise<SpindleMcpResult | unknown>;
  list(server: string): Promise<unknown>;
  list(args?: { server?: string }): Promise<unknown>;
  connect(server: string): Promise<unknown>;
  search(args: string | { query: string; server?: string; regex?: boolean; includeSchemas?: boolean }): Promise<unknown>;
  describe(args: string | { tool: string }): Promise<unknown>;
};
declare const pi: PiToolsApi;
declare const extensions: SpindleExtensionsApi;
declare const tools: SpindleToolsApi;
declare const agents: SpindleAgentsApi;
declare const mcp: SpindleMcpApi;
// Bounded-concurrency fan-out. Promise.all is the right tool for a handful of
// independent calls; mapLimit is for a wide list, because Promise.all receives
// promises that have already started and therefore cannot cap how many run at
// once. Defaults to unbounded when concurrency is omitted.
// A signal stops the pool launching further items and rejects; in-flight items
// cancel themselves only if they were handed the same signal.
declare function mapLimit<T, R>(items: T[], mapper: (item: T, index: number) => Promise<R> | R, concurrency?: number | { concurrency?: number; signal?: AbortSignal }): Promise<R[]>;
declare function mapLimit<T>(thunks: Array<() => Promise<T> | T>, concurrency?: number | { concurrency?: number; signal?: AbortSignal }): Promise<T[]>;
interface SpindleConsole {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
declare const console: SpindleConsole;
declare const π: Readonly<Record<string, string>>;
// The session scratchpad: JSON values that outlive this program and die with
// the session. τ = 2π, and the pairing is the point — π is this call's
// read-only payloads, τ is state shared across calls. Use it for a large
// intermediate the next program needs but the model should never read (a repo
// index, a parsed API response); prefer returning small values outright, and a
// file for anything big or long-lived. Writes are methods, not assignments,
// because they can fail: a value must be JSON-serializable (no closures, no
// handles), keys match [A-Za-z0-9][A-Za-z0-9_.:-]* and over a budget the write
// throws instead of evicting. The held keys are echoed in every result.
interface SpindleStateApi {
  /** The stored value, or undefined when the key is not held. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Store a JSON-serializable value, replacing any previous entry. */
  set(key: string, value: unknown): Promise<{ key: string; bytes: number; keys: string[] }>;
  /** Held keys with their serialized sizes. */
  keys(): Promise<Array<{ key: string; bytes: number; updatedAt: number }>>;
  delete(key: string): Promise<{ key: string; deleted: boolean; keys: string[] }>;
  clear(): Promise<{ cleared: number }>;
}
declare const τ: SpindleStateApi;
// Allowlisted host env (HOME, USER, LOGNAME, SHELL, PWD, PATH, LANG, LC_*,
// TERM, TMPDIR, XDG_*), platform facts, and the session working directory.
// Sensitive variables are never exposed to the sandbox.
declare const process: {
  env: Readonly<Record<string, string>>;
  platform: string;
  arch: string;
  cwd(): string;
};
declare function print(...args: unknown[]): void;
// Host APIs the engine does not ship, supplied by runtime/guest-polyfills.ts.
// The runtime injects each one only when the program text mentions it, so
// these declarations and that module's trigger lists must stay in step. There
// is deliberately no fetch, no crypto.subtle and no WebAssembly: those are
// capabilities rather than conveniences, and the audited host-call table is
// meant to be the only route out of the sandbox.
declare function queueMicrotask(callback: () => void): void;
// Cancellation. Passing a signal to a host call is not just a local promise
// race: the runtime tags the call, and an abort sends a cancel back through the
// bridge, so the in-flight host work is really aborted. Accepted by pi.bash,
// agents.run/runAll/start/wait, mapLimit, and any open-record namespace
// (extensions.*, mcp.*, tools.call). The remaining pi.* core tools are local
// filesystem operations that finish too fast to be worth cancelling and do not
// declare it.
interface SpindleAbortEvent {
  type: "abort";
  target: AbortSignal;
}
declare class AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  onabort: ((event: SpindleAbortEvent) => void) | null;
  throwIfAborted(): void;
  addEventListener(type: "abort", listener: (event: SpindleAbortEvent) => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: (event: SpindleAbortEvent) => void): void;
  static abort(reason?: unknown): AbortSignal;
  static timeout(milliseconds: number): AbortSignal;
  static any(signals: Iterable<AbortSignal>): AbortSignal;
}
declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
declare function atob(data: string): string;
declare function btoa(data: string): string;
declare const performance: {
  /** Milliseconds since context creation. Wall clock, not monotonic. */
  now(): number;
  readonly timeOrigin: number;
};
// utf-8 only. TextDecoder rejects any other label and does not stream.
declare class TextEncoder {
  readonly encoding: "utf-8";
  encode(input?: string): Uint8Array;
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: ArrayBuffer | ArrayBufferView): string;
}
// A real structured clone: preserves Map, Set, Date, RegExp and typed arrays,
// tolerates cycles, and throws on functions, symbols and promises.
declare function structuredClone<T>(value: T): T;
// getRandomValues draws from a fixed pool of host entropy and throws once it is
// exhausted, because a synchronous call cannot reach the async host bridge.
declare const crypto: {
  getRandomValues<T extends Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | BigInt64Array | BigUint64Array>(array: T): T;
  randomUUID(): string;
};
// A pragmatic URL, not a WHATWG-conformant one: authority parsing needs an
// explicit "//", hostnames are lowercased but not punycode-normalized, and
// percent-encoding is left as written.
declare class URLSearchParams {
  constructor(init?: string | Record<string, string> | Array<[string, string]> | URLSearchParams);
  readonly size: number;
  append(name: string, value: string): void;
  delete(name: string, value?: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string, value?: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  forEach(callback: (value: string, name: string, params: URLSearchParams) => void, thisArg?: unknown): void;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  entries(): IterableIterator<[string, string]>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
  toString(): string;
}
declare class URL {
  constructor(url: string | URL, base?: string | URL);
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toString(): string;
  toJSON(): string;
}
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number): number;
declare function clearTimeout(handle: number): void;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number): number;
declare function clearInterval(handle: number): void;
`;

const FULL_CODE_GLOBAL_DECLARATIONS = [
	"declare const pi: PiToolsApi;\n",
	"declare const extensions: SpindleExtensionsApi;\n",
	"declare const tools: SpindleToolsApi;\n",
];

const EXTENSIONS_LOOSE_DECLARATION = "declare const extensions: SpindleExtensionsApi;\n";

const terminatedDeclaration = (block: string): string => (block.endsWith("\n") ? block : `${block}\n`);

/**
 * Swap the loose dynamic-surface declarations for schema-typed ones. Applied
 * only when the loose anchor is still present: orchestration-only mode removes
 * it, and a missing section keeps the loose surface (see
 * runtime/dynamic-guest-types.ts).
 */
const applyDynamicDeclarations = (declarations: string, dynamic: SpindleDynamicGuestDeclarations): string =>
	dynamic.extensions && declarations.includes(EXTENSIONS_LOOSE_DECLARATION)
		? declarations.replace(EXTENSIONS_LOOSE_DECLARATION, terminatedDeclaration(dynamic.extensions))
		: declarations;

export const guestTypeDeclarations = (fullCodeMode: boolean, dynamic?: SpindleDynamicGuestDeclarations): string => {
	if (!fullCodeMode) {
		return FULL_CODE_GLOBAL_DECLARATIONS.reduce(
			(declarations, declaration) => declarations.replace(declaration, ""),
			GUEST_TYPE_DECLARATIONS,
		);
	}
	return dynamic ? applyDynamicDeclarations(GUEST_TYPE_DECLARATIONS, dynamic) : GUEST_TYPE_DECLARATIONS;
};
