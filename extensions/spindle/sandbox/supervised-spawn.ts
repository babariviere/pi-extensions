/**
 * Supervised process-tree spawn: the one implementation of "run a shell
 * command as its own process group and guarantee the whole tree dies when we
 * say so".
 *
 * Two adapters ride on it: the OS-sandbox wrap (`sandbox/manager.ts`, which
 * routes the command through `srt`) and the stdin-fed `pi.bash` extras path
 * (`providers/spindle-bash-tool.ts`). Both used to carry private copies of
 * the same supervision mechanics (detached process group, kill-tree on
 * timeout/abort, `timeout:<seconds>` / `aborted` error strings), so a fix to
 * one silently missed the other.
 *
 * The interface is deliberately small: run an already-wrapped command in
 * `cwd`, stream output, optionally pipe `stdin`, and enforce `timeout`
 * (seconds) and `signal`. Kill-tree, timer, and settle semantics are the
 * implementation and are tested here, once, through this interface.
 */

import { spawn } from "node:child_process";

export interface SupervisedSpawnOptions {
	/** Shell command line run under `bash -c`. Wrap it for the OS sandbox first. */
	command?: string;
	/** Program and arguments run directly, without shell parsing. */
	argv?: readonly string[];
	cwd: string;
	/** Stream both stdout and stderr here as they arrive. */
	onData: (data: Buffer) => void;
	/** Text piped to the command's stdin, which is then closed. */
	stdin?: string;
	/** Deadline in seconds; a timeout kills the whole tree and rejects. */
	timeout?: number;
	/** Aborting kills the whole tree and rejects with "aborted". */
	signal?: AbortSignal;
	/** Environment for the child; replaces the default when set. */
	env?: Record<string, string | undefined>;
}

/**
 * Run `command` as a detached process group so a timeout or abort kills the
 * whole tree (children included), not just `bash`. Resolves with the exit
 * code; rejects with `timeout:<seconds>` or `aborted`, matching pi's bash
 * tool error contract so tool-level error formatting still applies.
 */
export function supervisedSpawn(options: SupervisedSpawnOptions): Promise<{ exitCode: number | null }> {
	const { command, argv, cwd, onData, stdin, timeout, signal, env } = options;
	if ((command === undefined) === (argv === undefined)) {
		throw new Error("supervisedSpawn requires exactly one of command or argv");
	}
	if (argv !== undefined && argv.length === 0) throw new Error("supervisedSpawn argv must not be empty");
	return new Promise((resolve, reject) => {
		const child = argv === undefined ? spawn("bash", ["-c", command as string], {
			cwd,
			detached: true,
			stdio: stdin === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
			...(env ? { env } : {}),
		}) : spawn(argv[0]!, argv.slice(1), {
			cwd,
			detached: true,
			// A stdin pipe only when there is text to feed; callers without stdin
			// keep pi's "ignore" so the child never inherits our terminal.
			stdio: stdin === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
			...(env ? { env } : {}),
		});
		// The command may never read stdin; an EPIPE on our side must not fail it.
		if (stdin !== undefined) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(stdin);
		}

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
			timeout !== undefined && timeout > 0
				? setTimeout(() => {
						timedOut = true;
						killTree();
					}, timeout * 1000)
				: undefined;

		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);

		const onAbort = () => killTree();
		signal?.addEventListener("abort", onAbort, { once: true });

		const settle = (run: () => void) => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			run();
		};

		child.on("error", (error) => settle(() => reject(error)));
		child.on("close", (code) =>
			settle(() => {
				if (signal?.aborted) reject(new Error("aborted"));
				else if (timedOut) reject(new Error(`timeout:${timeout}`));
				else resolve({ exitCode: code });
			}),
		);
	});
}
