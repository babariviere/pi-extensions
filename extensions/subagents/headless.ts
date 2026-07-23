/**
 * Headless adapter: spawn a `pi` child process per run, wait for it to exit,
 * then resolve its output via the shared three-tier rule. Batch-shaped to match
 * the `RunBackend` seam; runs fan out with Promise.all since each is an
 * independent child process.
 */

import { spawn } from "node:child_process";
import { readDefaultProvider } from "./settings.ts";
import {
	prepareChildRun,
	resolveRunOutput,
	type RunContext,
	type RunRequest,
	type RunResult,
} from "./run.ts";

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

		const child = spawn("pi", childArgs, { cwd: ctx.cwd });
		ctx.onStatus?.(req.index, { state: "running", outputPath });

		const finish = async (exitCode: number | null, error: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ctx.signal?.removeEventListener("abort", onAbort);
			const resolved = await resolveRunOutput({
				outputPath,
				sessionPath,
				fallback: () => stdout.trim() || undefined,
				finishedCleanly: exitCode === 0,
			});
			ctx.onStatus?.(req.index, { state: resolved.ok ? "done" : "failed", outputPath });
			resolve({
				agent: req.agent.config.name,
				scope: req.agent.scope,
				ok: resolved.ok,
				output: resolved.output,
				outputPath,
				exitCode: exitCode ?? undefined,
				error,
			});
		};

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			void finish(null, `timed out after ${ctx.timeoutMs}ms`);
		}, ctx.timeoutMs);

		const onAbort = () => child.kill("SIGKILL");
		ctx.signal?.addEventListener("abort", onAbort, { once: true });

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
			const err = code === 0 ? undefined : (stderr.trim() || `pi exited with code ${code}`);
			void finish(code, err);
		});
	});
}
