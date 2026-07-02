/**
 * Headless backend: spawn a `pi` child process, wait for it to exit, then read
 * its output file (falling back to captured stdout).
 */

import { spawn } from "node:child_process";
import { OUTPUT_PATH_ENV } from "./constants.ts";
import { buildChildArgs } from "./pi-args.ts";
import { runPaths } from "./paths.ts";
import { readDefaultProvider } from "./settings.ts";
import {
	ensureRunDir,
	type OnStatus,
	readLastAssistantText,
	readOutputFile,
	type RunRequest,
	type RunResult,
	writeSystemPrompt,
} from "./run.ts";

export interface HeadlessContext {
	sessionId: string | undefined;
	runId: string;
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onStatus?: OnStatus;
}

export function runHeadless(req: RunRequest, ctx: HeadlessContext): Promise<RunResult> {
	const paths = runPaths(ctx.sessionId, ctx.runId, req.agent.config.name, req.index);
	ensureRunDir(paths.dir);

	const hasPrompt = req.agent.systemPrompt.trim().length > 0;
	if (hasPrompt) writeSystemPrompt(paths.promptPath, req.agent.systemPrompt);

	const args = buildChildArgs(req.agent, req.task, {
		sessionFile: paths.sessionPath,
		systemPromptFile: hasPrompt ? paths.promptPath : undefined,
		defaultProvider: readDefaultProvider(ctx.cwd),
	});

	return new Promise<RunResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;

		const child = spawn("pi", args, {
			cwd: ctx.cwd,
			env: { ...process.env, [OUTPUT_PATH_ENV]: paths.outputPath },
		});
		ctx.onStatus?.(req.index, { state: "running", outputPath: paths.outputPath });

		const finish = (result: RunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ctx.signal?.removeEventListener("abort", onAbort);
			ctx.onStatus?.(req.index, {
				state: result.ok ? "done" : "failed",
				outputPath: paths.outputPath,
			});
			resolve(result);
		};

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(buildResult(req, paths.outputPath, paths.sessionPath, null, stdout, `timed out after ${ctx.timeoutMs}ms`));
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
			finish(buildResult(req, paths.outputPath, paths.sessionPath, null, stdout, err.message));
		});
		child.on("close", (code) => {
			const err = code === 0 ? undefined : (stderr.trim() || `pi exited with code ${code}`);
			finish(buildResult(req, paths.outputPath, paths.sessionPath, code, stdout, err));
		});
	});
}

function buildResult(
	req: RunRequest,
	outputPath: string,
	sessionPath: string,
	exitCode: number | null,
	stdout: string,
	error: string | undefined,
): RunResult {
	// Prefer the submit_result file; otherwise recover the agent's final answer
	// from the child session transcript (it may have ended with a plain message
	// instead of calling submit_result), then fall back to captured stdout.
	const fileOutput = readOutputFile(outputPath) ?? readLastAssistantText(sessionPath);
	const output = fileOutput ?? stdout.trim();
	const ok = exitCode === 0 && (fileOutput !== undefined || stdout.trim().length > 0);
	return {
		agent: req.agent.config.name,
		scope: req.agent.scope,
		ok,
		output: output || "(no output produced)",
		outputPath,
		exitCode: exitCode ?? undefined,
		error,
	};
}
