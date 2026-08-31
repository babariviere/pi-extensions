/**
 * Runtime plumbing for the filesystem sandbox: loading `srt`, initializing it
 * for a policy, and the `bash` operations that route through it.
 *
 * Everything here is stateless with respect to the *current* policy. The state
 * lives in `SandboxController`, because the mode can change mid-session (a night
 * run turning enforcement on), and the tool definitions pi builds at session
 * start must keep working across that change.
 *
 * `@anthropic-ai/sandbox-runtime` is an optional dependency, imported through a
 * variable specifier so a missing install degrades instead of breaking startup.
 */

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { hasUnrestrictedEgress, type SandboxPolicy, toSandboxRuntimeConfig } from "./policy.ts";
import { supervisedSpawn } from "./supervised-spawn.ts";

const RUNTIME_MODULE = "@anthropic-ai/sandbox-runtime";

/**
 * `srt`'s network permission hook. It is called for a host no allow or deny
 * rule matched, and a missing hook means "deny".
 */
export type SandboxAskCallback = (request: { host: string; port: number }) => Promise<boolean>;

/** The slice of `srt`'s SandboxManager this module uses. */
export interface SandboxRuntime {
	initialize(config: unknown, ask?: SandboxAskCallback): Promise<void>;
	wrapWithSandbox(command: string): Promise<string>;
	reset(): Promise<void>;
}

/**
 * The permission hook a policy needs, or undefined when the allowlist already
 * names every host it wants.
 *
 * `srt` is allow-only and its patterns are an exact host or `*.example.com`:
 * there is no spelling for "any host", and its own config schema rejects a bare
 * `*` as too broad. So spindle's `*` cannot be passed through, and passing it
 * anyway denied *all* egress, including hosts a night run had explicitly
 * allowlisted (the proxy answered 403 to every CONNECT). Unrestricted egress is
 * expressed as a hook that approves whatever no rule matched instead.
 * `deniedDomains` is checked before the hook, so the kill switch still wins.
 */
export function sandboxAskCallback(policy: SandboxPolicy): SandboxAskCallback | undefined {
	return hasUnrestrictedEgress(policy) ? async () => true : undefined;
}

/** Platforms `srt` can enforce on. Everything else gets path guards only. */
const OS_SUPPORTED: ReadonlySet<string> = new Set(["darwin", "linux"]);

async function loadRuntime(): Promise<{ runtime?: SandboxRuntime; error?: string }> {
	try {
		const specifier = RUNTIME_MODULE;
		const loaded = (await import(specifier)) as { SandboxManager?: SandboxRuntime };
		if (!loaded?.SandboxManager) return { error: `${RUNTIME_MODULE} exports no SandboxManager` };
		return { runtime: loaded.SandboxManager };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `${RUNTIME_MODULE} unavailable (${message})` };
	}
}

export interface RuntimeAttempt {
	runtime?: SandboxRuntime;
	/** Why the OS sandbox is not active. Undefined when it is. */
	degradedReason?: string;
}

/**
 * Bring the OS sandbox up for `policy`. Never throws: an unsupported platform, a
 * missing install or a failed init all return a reason, and the caller falls
 * back to path guards on `write`/`edit`.
 */
export async function initializeSandboxRuntime(policy: SandboxPolicy): Promise<RuntimeAttempt> {
	if (!OS_SUPPORTED.has(process.platform)) {
		return { degradedReason: `no OS sandbox on ${process.platform}; write/edit path guards only` };
	}
	const { runtime, error } = await loadRuntime();
	if (!runtime) return { degradedReason: error };
	try {
		await runtime.initialize(toSandboxRuntimeConfig(policy), sandboxAskCallback(policy));
		return { runtime };
	} catch (initError) {
		const message = initError instanceof Error ? initError.message : String(initError);
		return { degradedReason: `sandbox init failed (${message})` };
	}
}

/**
 * `BashOperations` that consult `current()` on every call, so the same object
 * installed at session start follows a mid-session mode change. With no runtime
 * it delegates to pi's own local shell backend, which keeps unsandboxed
 * behaviour byte-identical to the default tool.
 *
 * The sandboxed path wraps the command through `srt` and hands it to the
 * shared supervised spawn (`./supervised-spawn.ts`), which owns the detached
 * process group and the timeout/abort kill-tree. `timeout` is in seconds,
 * matching pi's bash tool contract.
 */
export function lateBoundBashOperations(current: () => SandboxRuntime | undefined, shellPath?: string): BashOperations {
	const local = createLocalBashOperations(shellPath ? { shellPath } : undefined);
	return {
		async exec(command, cwd, options) {
			const runtime = current();
			if (!runtime) return local.exec(command, cwd, options);

			const { onData, signal, timeout, env } = options;
			const wrapped = await runtime.wrapWithSandbox(command);
			return supervisedSpawn({
				command: wrapped,
				cwd,
				onData,
				...(signal ? { signal } : {}),
				...(timeout !== undefined ? { timeout } : {}),
				...(env ? { env } : {}),
			});
		},
	};
}
