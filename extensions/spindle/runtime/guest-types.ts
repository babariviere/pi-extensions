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
import type { SpindleToolGate } from "../core/tool-allowlist.ts";

export const GUEST_TYPE_DECLARATIONS = `
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
interface PiToolsApi {
  read(args: string | { path: string; offset?: number; limit?: number; start?: number; max?: number } | { file: string; offset?: number; limit?: number; start?: number; max?: number }): Promise<string>;
  bash(args: string | { command: string; timeout?: number; timeoutMs?: number; settle?: boolean } | { cmd: string; timeout?: number; timeoutMs?: number; settle?: boolean } | { shell: string; timeout?: number; timeoutMs?: number; settle?: boolean }): Promise<{ ok: true; output: string; details: unknown } | { ok: false; output: string; details: null; exitCode: number; error: string }>;
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
}
interface SpindleAgentResult {
  agent: string;
  ok: boolean;
  output: string;
  outputPath: string;
  exitCode?: number;
  paneId?: string;
  error?: string;
}
interface SpindleAgentsApi {
  list(): Promise<SpindleAgentDefinition[]>;
  run(args: SpindleAgentRequest): Promise<SpindleAgentResult>;
  runAll(args: { tasks: SpindleAgentRequest[] } | SpindleAgentRequest[]): Promise<SpindleAgentResult[]>;
}
interface SpindleMcpResult {
  text: string;
  content: unknown[];
  structuredContent: unknown;
}
interface SpindleMcpTool {
  (args?: Record<string, unknown>): Promise<SpindleMcpResult | unknown>;
}
interface SpindleMcpServer {
  // mcp.<server>() lists the server's tools; mcp.<server>.<tool>(args) calls one.
  (): Promise<unknown>;
  [tool: string]: SpindleMcpTool;
}
// Servers connect lazily inside pi-mcp-adapter: nothing here pre-fetches a
// tool list, so a call never forces every configured server to connect.
type SpindleMcpApi = Record<string, SpindleMcpServer> & {
  call(server: string, tool: string, args?: Record<string, unknown>): Promise<SpindleMcpResult | unknown>;
  call(args: { server?: string; tool: string; args?: Record<string, unknown> }): Promise<SpindleMcpResult | unknown>;
  list(server: string): Promise<unknown>;
  list(args?: { server?: string }): Promise<unknown>;
  connect(server: string): Promise<unknown>;
  search(args: string | { query: string; server?: string; regex?: boolean; includeSchemas?: boolean }): Promise<unknown>;
  describe(args: string | { tool: string }): Promise<unknown>;
};
type SpindleActivityStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "stopped";
type SpindleActivityKind = "agent" | "actor" | "tool" | "extension" | "mcp" | "mesh" | "task" | "custom";
interface SpindleWorkflowDisplay {
  name?: string;
  description?: string;
}
interface SpindleWorkflowPhaseOptions {
  id?: string;
  description?: string;
  total?: number;
}
interface SpindleWorkflowPhaseInput extends SpindleWorkflowPhaseOptions {
  name: string;
}
interface SpindleWorkflowItem {
  id: string;
  label: string;
  status?: SpindleActivityStatus;
  phase?: string;
  detail?: string;
  kind?: SpindleActivityKind;
  current?: string;
  total?: number;
  completed?: number;
  data?: unknown;
}
interface SpindleWorkflowApi {
  parallel<T, R>(items: T[], mapper: (item: T, index: number) => Promise<R> | R, concurrency?: number | { concurrency?: number }): Promise<R[]>;
  parallel<T>(thunks: Array<() => Promise<T> | T>, concurrency?: number | { concurrency?: number }): Promise<T[]>;
  pipeline<T>(items: T[], ...stages: Array<(value: unknown, original: T, index: number) => Promise<unknown> | unknown>): Promise<unknown[]>;
  configure(display: SpindleWorkflowDisplay): Promise<SpindleWorkflowDisplay>;
  phase(name: string, options?: SpindleWorkflowPhaseOptions): Promise<{ name: string; index: number; id?: string }>;
  phase(input: SpindleWorkflowPhaseInput): Promise<{ name: string; index: number; id?: string }>;
  item(item: SpindleWorkflowItem): Promise<SpindleWorkflowItem>;
  event(event: { message: string; level?: "info" | "success" | "warning" | "error"; data?: unknown }): Promise<void>;
  log(...values: unknown[]): void;
}
declare const pi: PiToolsApi;
declare const extensions: SpindleExtensionsApi;
declare const tools: SpindleToolsApi;
declare const agents: SpindleAgentsApi;
declare const mcp: SpindleMcpApi;
declare const workflow: SpindleWorkflowApi;
declare function parallel<T, R>(items: T[], mapper: (item: T, index: number) => Promise<R> | R, concurrency?: number | { concurrency?: number }): Promise<R[]>;
declare function parallel<T>(thunks: Array<() => Promise<T> | T>, concurrency?: number | { concurrency?: number }): Promise<T[]>;
declare function pipeline<T>(items: T[], ...stages: Array<(value: unknown, original: T, index: number) => Promise<unknown> | unknown>): Promise<unknown[]>;
declare function phase(name: string, options?: SpindleWorkflowPhaseOptions): Promise<{ name: string; index: number; id?: string }>;
declare function phase(input: SpindleWorkflowPhaseInput): Promise<{ name: string; index: number; id?: string }>;
declare function log(...values: unknown[]): void;
interface SpindleConsole {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
declare const console: SpindleConsole;
declare const π: Readonly<Record<string, string>>;
declare function print(...args: unknown[]): void;
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

const PI_TOOLS_API_HEADER = "interface PiToolsApi {";
const PI_TOOLS_API_MEMBER = /^ {2}([A-Za-z][A-Za-z0-9_]*)\(/;

/**
 * Drop the disallowed `pi.*` members from `PiToolsApi` so the schema handed to
 * the type-checker describes only what a restricted subagent may call. When
 * nothing is left, the `pi` global goes too.
 */
const restrictPiTools = (declarations: string, gate: SpindleToolGate): string => {
  const lines = declarations.split("\n");
  const kept: string[] = [];
  let inPiTools = false;
  let members = 0;
  for (const line of lines) {
    if (!inPiTools) {
      inPiTools = line.startsWith(PI_TOOLS_API_HEADER);
      kept.push(line);
      continue;
    }
    if (line === "}") {
      inPiTools = false;
      kept.push(line);
      continue;
    }
    const member = PI_TOOLS_API_MEMBER.exec(line);
    if (member) {
      if (!gate.allows(member[1])) continue;
      members++;
    }
    kept.push(line);
  }
  const restricted = kept.join("\n");
  return members > 0 ? restricted : restricted.replace("declare const pi: PiToolsApi;\n", "");
};

export const guestTypeDeclarations = (
  fullCodeMode: boolean,
  gate?: SpindleToolGate,
): string => {
  if (!fullCodeMode) {
    return FULL_CODE_GLOBAL_DECLARATIONS.reduce(
      (declarations, declaration) => declarations.replace(declaration, ""),
      GUEST_TYPE_DECLARATIONS,
    );
  }
  return gate?.restricted
    ? restrictPiTools(GUEST_TYPE_DECLARATIONS, gate)
    : GUEST_TYPE_DECLARATIONS;
};
