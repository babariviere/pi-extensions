/**
 * The session's live sandbox state.
 *
 * pi builds its tool definitions once, at session start, and bakes the
 * operations objects in. The sandbox mode, however, can change later: a night
 * run asks for enforcement hours after the session began. So the operations this
 * controller hands out are stable objects whose closures read the *current*
 * policy on every call, and `apply` swaps the policy underneath them.
 *
 * When nothing is enforced the operations are pass-throughs, so an unsandboxed
 * session behaves exactly as it did before this existed.
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import type {
  BashOperations,
  EditOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  initializeSandboxRuntime,
  lateBoundBashOperations,
  type RuntimeAttempt,
  type SandboxRuntime,
} from "./manager.ts";
import {
  assertReadAllowed,
  assertWriteAllowed,
  describeSandbox,
  isEnforcing,
  isWriteAllowed,
  type SandboxPolicy,
} from "./policy.ts";
import type { SandboxStateEvent } from "./protocol.ts";

/** Where the active policy came from, for status output. */
export type SandboxSource = "config" | "request";

export class SandboxController {
  #policy: SandboxPolicy;
  #source: SandboxSource;
  #runtime: SandboxRuntime | undefined;
  #degradedReason: string | undefined;
  /** Stable operations, installed once and never replaced. */
  readonly #bash: BashOperations;
  /** Injected in tests so the suite never brings up a real OS sandbox. */
  readonly #startRuntime: (policy: SandboxPolicy) => Promise<RuntimeAttempt>;

  constructor(
    policy: SandboxPolicy,
    source: SandboxSource = "config",
    startRuntime: (policy: SandboxPolicy) => Promise<RuntimeAttempt> = initializeSandboxRuntime,
  ) {
    this.#policy = policy;
    this.#source = source;
    this.#startRuntime = startRuntime;
    this.#bash = lateBoundBashOperations(() => this.#runtime);
  }

  get policy(): SandboxPolicy {
    return this.#policy;
  }

  get enforcing(): boolean {
    return isEnforcing(this.#policy);
  }

  /** True when `bash` is bounded by the kernel, not just by path checks. */
  get osEnforced(): boolean {
    return this.#runtime !== undefined;
  }

  get degradedReason(): string | undefined {
    return this.#degradedReason;
  }

  /**
   * Adopt `policy`. Brings the OS sandbox up when the new policy enforces
   * something, tears it down when it does not. Returns the resulting state.
   */
  async apply(policy: SandboxPolicy, source: SandboxSource): Promise<SandboxStateEvent> {
    const wasEnforcing = this.enforcing;
    this.#policy = policy;
    this.#source = source;

    if (!isEnforcing(policy)) {
      if (wasEnforcing) await this.#resetRuntime();
      this.#degradedReason = undefined;
      return this.state();
    }

    // Re-initializing replaces the previous profile, so an already-running
    // runtime is reset first rather than layered on.
    await this.#resetRuntime();
    const attempt = await this.#startRuntime(policy);
    this.#runtime = attempt.runtime;
    this.#degradedReason = attempt.degradedReason;
    return this.state();
  }

  async #resetRuntime(): Promise<void> {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    if (!runtime) return;
    try {
      await runtime.reset();
    } catch {
      // Best effort: a stale profile is dropped when the process exits.
    }
  }

  state(): SandboxStateEvent {
    return {
      mode: this.#policy.mode,
      enforcing: this.enforcing,
      osEnforced: this.osEnforced,
      writableRoots: this.#policy.allowWrite.length,
      source: this.#source,
      ...(this.#degradedReason ? { degradedReason: this.#degradedReason } : {}),
    };
  }

  describe(): string {
    const base = describeSandbox(this.#policy);
    if (!this.enforcing) return base;
    return this.osEnforced ? `${base}, bash OS-enforced` : `${base}, ${this.#degradedReason}`;
  }

  /** Stable `bash` operations. Always installed; a no-op when nothing is enforced. */
  bashOperations(): BashOperations {
    return this.#bash;
  }

  /**
   * Wrap a command for the OS sandbox when one is active; identity otherwise.
   * Used by spindle-owned exec paths (pi.bash stdin) so they stay bounded by
   * the same policy as the operations above.
   */
  wrapCommand(command: string): Promise<string> {
    const runtime = this.#runtime;
    return runtime ? runtime.wrapWithSandbox(command) : Promise.resolve(command);
  }

  /** Path check for Spindle's preview write tool, which does its own writing. */
  writeGuard(): (absolutePath: string) => void {
    return (absolutePath: string) => {
      if (!this.enforcing) return;
      assertWriteAllowed(this.#policy, absolutePath);
    };
  }

  /**
   * Stable path check for the read tools (`read` / `grep` / `find` / `ls`),
   * enforcing the policy's denyRead roots. Reads outside those roots stay
   * untouched, so image handling and truncation behave exactly like pi's.
   */
  readGuard(): (absolutePath: string) => void {
    return (absolutePath: string) => {
      if (!this.enforcing) return;
      assertReadAllowed(this.#policy, absolutePath);
    };
  }

  /** Guarded `WriteOperations`, for pi's unmodified write tool. */
  writeOperations(): WriteOperations {
    return {
      writeFile: async (path, content) => {
        this.#assertWrite(path);
        await writeFile(path, content, "utf8");
      },
      mkdir: async (path) => {
        this.#assertWrite(path);
        await mkdir(path, { recursive: true });
      },
    };
  }

  /** Guarded `EditOperations`: reads pass through, writes are checked. */
  editOperations(): EditOperations {
    return {
      // EditOperations reads as a Buffer; only the write side is policed.
      readFile: (path) => readFile(path),
      writeFile: async (path, content) => {
        this.#assertWrite(path);
        await writeFile(path, content, "utf8");
      },
      access: (path) => access(path),
    };
  }

  /** True when a write to `absolutePath` would be permitted right now. */
  allowsWrite(absolutePath: string): boolean {
    return isWriteAllowed(this.#policy, absolutePath);
  }

  #assertWrite(absolutePath: string): void {
    if (!this.enforcing) return;
    assertWriteAllowed(this.#policy, absolutePath);
  }

  async dispose(): Promise<void> {
    await this.#resetRuntime();
  }
}
