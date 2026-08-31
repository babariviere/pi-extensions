/**
 * Headless adapter: spawn a `pi` child process per run, wait for it to exit,
 * then resolve its output via the shared three-tier rule. Batch-shaped to match
 * the `RunBackend` seam; runs fan out with Promise.all since each is an
 * independent child process.
 *
 * Teardown: every child gets its own process group (`detached: true`) so a
 * timeout or a cancelled parent tears down the child *and* the subprocesses it
 * spawned (see `process-tree.ts`).
 */

import { spawn } from "node:child_process";
import { NIGHT_RUN_ENV } from "../../night-mode/night-run.ts";
import { readDefaultProvider } from "./settings.ts";
import { resolveRunOutput } from "./output.ts";
import { DEFAULT_KILL_GRACE_MS, terminateProcessTree, type TerminateHandle } from "./process-tree.ts";
import { baseResult, prepareChildRun, runCwd, type RunContext, type RunRequest, type RunResult } from "./run.ts";

/** Error recorded when the parent session cancels a run. */
const CANCELLED_RUN_ERROR = "cancelled by the parent session";

/**
 * How long after a teardown starts a run resolves even if `close` never fires
 * (a wedged pty, an unreapable child). The SIGKILL lands at
 * DEFAULT_KILL_GRACE_MS, so this only covers the pathological case.
 */
const CLOSE_FALLBACK_MS = DEFAULT_KILL_GRACE_MS + 1_000;

export function runHeadlessBatch(reqs: RunRequest[], ctx: RunContext): Promise<RunResult[]> {
	const defaultProvider = readDefaultProvider(ctx.cwd);
	return Promise.all(reqs.map((req) => runHeadless(req, ctx, defaultProvider)));
}

function runHeadless(req: RunRequest, ctx: RunContext, defaultProvider: string | undefined): Promise<RunResult> {
	const prepared = prepareChildRun(req, ctx, { defaultProvider, includeTask: true });
	const { outputPath, sessionPath, childArgs } = prepared;

	return new Promise<RunResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;

		// The night marker travels in the environment: the child's own spindle reads
		// it to decide whether to inherit the run's sandbox (`sandbox/night-bridge.ts`).
		const child = spawn("pi", childArgs, {
			cwd: runCwd(req, ctx),
			// Own process group, so teardown reaches the child's own subprocesses.
			detached: true,
			...(req.night ? { env: { ...process.env, [NIGHT_RUN_ENV]: "1" } } : {}),
		});
		ctx.onStatus?.(req.index, { state: "running", outputPath });

		let teardown: TerminateHandle | undefined;
		let fallbackTimer: NodeJS.Timeout | undefined;
		/** Why the run was torn down; becomes the result's error. */
		let stopReason: string | undefined;

		const finish = async (exitCode: number | null, error: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (fallbackTimer) clearTimeout(fallbackTimer);
			teardown?.cancel();
			ctx.signal?.removeEventListener("abort", onAbort);
			const resolved = await resolveRunOutput(outputPath, sessionPath, {
				fallback: () => stdout.trim() || undefined,
				finishedCleanly: exitCode === 0 && stopReason === undefined,
			});
			ctx.onStatus?.(req.index, { state: resolved.ok ? "done" : "failed", outputPath });
			resolve({
				...baseResult(req, resolved, error),
				backend: "headless",
				exitCode: exitCode ?? undefined,
			});
		};

		/**
		 * Tear the run down for `reason`, then let `close` resolve it, so a killed
		 * run still reports the output it produced (SIGTERM gives the child a
		 * chance to flush its transcript before the SIGKILL).
		 */
		const stop = (reason: string): void => {
			stopReason ??= reason;
			if (teardown) return;
			teardown = terminateProcessTree(child);
			fallbackTimer = setTimeout(() => void finish(null, stopReason), CLOSE_FALLBACK_MS);
			fallbackTimer.unref?.();
		};

		const timer = setTimeout(() => stop(`timed out after ${ctx.timeoutMs}ms`), ctx.timeoutMs);

		const onAbort = () => stop(CANCELLED_RUN_ERROR);
		ctx.signal?.addEventListener("abort", onAbort, { once: true });
		// An already-aborted signal never fires the listener, and the batch can be
		// cancelled between launch and spawn (the backend probe awaits).
		if (ctx.signal?.aborted) stop(CANCELLED_RUN_ERROR);

		child.stdout?.on("data", (d) => {
			stdout += d.toString("utf-8");
		});
		child.stderr?.on("data", (d) => {
			stderr += d.toString("utf-8");
		});
		child.on("error", (err) => {
			void finish(null, err.message);
		});
		child.on("close", (code) => {
			const err = stopReason ?? (code === 0 ? undefined : stderr.trim() || `pi exited with code ${code}`);
			void finish(code, err);
		});
	});
}
