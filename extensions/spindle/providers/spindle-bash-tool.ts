/**
 * Spindle's `pi.bash` tool definition.
 *
 * Wraps pi's bash tool with three per-call extras the sandboxed guest can
 * pass alongside `command`:
 *
 * - `cwd`: absolute working directory for this one command
 * - `env`: extra variables merged over the shell environment
 * - `stdin`: text piped to the command (replaces quoting tricks such as
 *   `printf ... | ssh host bash -s`)
 *
 * The extras never reach pi's own tool schema: the wrapper validates them,
 * builds a per-call tool instance whose `BashOperations` applies them, and
 * runs that. Per-call construction keeps every invocation independent, so
 * concurrent `Promise.all` bash calls cannot race on shared state. The
 * extras-free path delegates to the shared base tool unchanged.
 *
 * `stdin` needs a spindle-owned spawn: both exec paths pi provides use
 * `stdio: ["ignore", ...]`. The spawn mirrors `sandbox/manager.ts` (detached
 * child, process-tree kill on abort/timeout, `timeout:<seconds>` / `aborted`
 * error strings) so pi's tool-level error formatting still applies, and
 * routes the command through the OS-sandbox wrap when one is active.
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const MAX_STDIN_CHARS = 8 * 1024 * 1024;

export interface SpindleBashSandbox {
  /** Late-bound (policy-aware) operations, normally the sandbox controller's. */
  operations?: BashOperations;
  /** Wrap a command for the OS sandbox when one is active; identity otherwise. */
  wrapCommand?: (command: string) => Promise<string>;
}

const spindleBashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Absolute working directory for this command" }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Extra environment variables, merged over the shell environment",
    }),
  ),
  stdin: Type.Optional(
    Type.String({ description: "Text piped to the command's stdin" }),
  ),
});

const SKIPPED_ENV_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const execWithStdin = async (
  command: string,
  cwd: string,
  options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: Record<string, string | undefined>;
    stdin: string;
  },
  wrapCommand: (command: string) => Promise<string>,
): Promise<{ exitCode: number | null }> => {
  const wrapped = await wrapCommand(command);
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", wrapped], {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.env ? { env: options.env } : {}),
    });
    // The command may never read stdin; an EPIPE on our side must not fail it.
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin);

    let timedOut = false;
    const killTree = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer =
      options.timeout !== undefined && options.timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree();
          }, options.timeout * 1000)
        : undefined;

    child.stdout?.on("data", options.onData);
    child.stderr?.on("data", options.onData);

    const onAbort = () => killTree();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const settle = (run: () => void) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      run();
    };

    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code) =>
      settle(() => {
        if (options.signal?.aborted) reject(new Error("aborted"));
        else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
        else resolve({ exitCode: code });
      }),
    );
  });
};

export const createSpindleBashToolDefinition = (
  cwd: string,
  sandbox: SpindleBashSandbox = {},
): ToolDefinition<any, any, any> => {
  const base = createBashToolDefinition(
    cwd,
    sandbox.operations ? { operations: sandbox.operations } : undefined,
  );
  const inner = sandbox.operations ?? createLocalBashOperations();
  const wrapCommand =
    sandbox.wrapCommand ?? ((command: string) => Promise.resolve(command));

  return {
    name: "bash",
    label: base.label,
    description:
      `${base.description} Optional per-call extras: cwd (absolute working directory for this command), ` +
      "env (extra variables merged over the shell environment), and stdin (text piped to the " +
      "command, e.g. pi.bash({ command: 'ssh host bash -s', stdin: script })).",
    promptSnippet: base.promptSnippet,
    promptGuidelines: base.promptGuidelines,
    parameters: spindleBashSchema,
    async execute(toolCallId, args, signal, onUpdate, ctx) {
      const callArgs = args as {
        command: string;
        timeout?: number;
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
      };
      const {
        command,
        timeout,
        cwd: callCwd,
        env: callEnv,
        stdin: callStdin,
      } = callArgs;
      if (callCwd === undefined && callEnv === undefined && callStdin === undefined) {
        return base.execute(toolCallId, callArgs, signal, onUpdate, ctx);
      }

      if (callCwd !== undefined) {
        if (typeof callCwd !== "string" || !isAbsolute(callCwd)) {
          throw new Error(
            `pi.bash cwd must be an absolute path (got: ${JSON.stringify(callCwd)})`,
          );
        }
        const info = await stat(callCwd).catch(() => undefined);
        if (info === undefined || !info.isDirectory()) {
          throw new Error(`pi.bash cwd is not an existing directory: ${callCwd}`);
        }
      }

      let mergedCallEnv: Record<string, string> | undefined;
      if (callEnv !== undefined && callEnv !== null && typeof callEnv === "object") {
        mergedCallEnv = {};
        for (const [key, value] of Object.entries(callEnv)) {
          if (SKIPPED_ENV_KEYS.has(key)) continue;
          if (typeof value !== "string") {
            throw new Error(`pi.bash env values must be strings (${key} is ${typeof value})`);
          }
          mergedCallEnv[key] = value;
        }
      }

      if (callStdin !== undefined && callStdin.length > MAX_STDIN_CHARS) {
        throw new Error(
          `pi.bash stdin is ${callStdin.length} chars; the limit is ${MAX_STDIN_CHARS}`,
        );
      }

      const operations: BashOperations = {
        exec: (innerCommand, defaultCwd, options) => {
          const effectiveCwd = callCwd ?? defaultCwd;
          const env =
            mergedCallEnv !== undefined
              ? { ...(options.env ?? {}), ...mergedCallEnv }
              : options.env;
          if (callStdin === undefined) {
            return inner.exec(innerCommand, effectiveCwd, { ...options, env });
          }
          return execWithStdin(
            innerCommand,
            effectiveCwd,
            { ...options, env, stdin: callStdin },
            wrapCommand,
          );
        },
      };
      const perCall = createBashToolDefinition(cwd, { operations });
      return perCall.execute(toolCallId, { command, timeout }, signal, onUpdate, ctx);
    },
  };
};
