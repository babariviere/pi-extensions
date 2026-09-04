/**
 * Runtime plumbing for the filesystem sandbox: constructing and initializing
 * the Seatbelt backend for a policy, and the `bash` operations that route
 * through it.
 *
 * Everything here is stateless with respect to the *current* policy. The
 * state lives in `SandboxController`, because the mode can change mid-session
 * (a night run turning enforcement on), and the tool definitions pi builds at
 * session start must keep working across that change.
 *
 * There is no optional dependency and no graceful degradation any more: an
 * enforcing mode either brings up a real OS sandbox or `bash` refuses to run.
 * See `seatbelt.ts` for the backend itself.
 */

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxPolicy } from "./policy.ts";
import { SeatbeltSandbox } from "./seatbelt.ts";
import { supervisedSpawn } from "./supervised-spawn.ts";

/** The slice of the Seatbelt backend this module (and the controller) uses. */
export interface SandboxRuntime {
	initialize(policy: SandboxPolicy): Promise<void>;
	wrapWithSandbox(command: string): Promise<string>;
	reset(): Promise<void>;
	/**
	 * Roots that were canonicalized (a symlinked root resolved to its target)
	 * or dropped, from the last `initialize()`. Empty when there is nothing an
	 * operator needs to see. `SandboxController` surfaces these on the
	 * `SandboxStateEvent`, the same way `degradedReason` already travels.
	 */
	warnings?: string[];
}

/**
 * Bring the OS sandbox up for `policy`. Constructs a `SeatbeltSandbox`,
 * initializes it, and returns it — or throws. There is no more "degrade to
 * path guards only": an enforcing mode either gets a real kernel sandbox or
 * the caller (`SandboxController.apply`) records why it could not, and
 * `bash` refuses to run rather than running unsandboxed.
 */
export async function initializeSandboxRuntime(
	policy: SandboxPolicy,
	platform: NodeJS.Platform = process.platform,
): Promise<SandboxRuntime> {
	const runtime = new SeatbeltSandbox(undefined, platform);
	await runtime.initialize(policy);
	return runtime;
}

/**
 * `BashOperations` that consult `current()` on every call, so the same object
 * installed at session start follows a mid-session mode change. With no
 * runtime and nothing enforcing, it delegates to pi's own local shell
 * backend, which keeps unsandboxed behaviour byte-identical to the default
 * tool. With no runtime while enforcement is supposed to be active,
 * `failure()` names why, and `exec` throws that reason instead of silently
 * running the command unsandboxed.
 *
 * The sandboxed path wraps the command through the Seatbelt backend and hands
 * it to the shared supervised spawn (`./supervised-spawn.ts`), which owns the
 * detached process group and the timeout/abort kill-tree. `timeout` is in
 * seconds, matching pi's bash tool contract.
 */
export function lateBoundBashOperations(
	current: () => SandboxRuntime | undefined,
	failure: () => string | undefined,
	shellPath?: string,
): BashOperations {
	const local = createLocalBashOperations(shellPath ? { shellPath } : undefined);
	return {
		async exec(command, cwd, options) {
			const runtime = current();
			if (!runtime) {
				const reason = failure();
				if (reason) throw new Error(reason);
				return local.exec(command, cwd, options);
			}

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
