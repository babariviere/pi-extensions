/** Isolated native kernels. Model turns and tool intent belong to each worker's durable Harness. */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { nightChildEnv, readActiveNightRun } from "../night-mode/night-run.ts";
import { prepareConfigHome } from "../night-mode/sandbox-clone.ts";
import { runPaths, sanitizeSegment } from "./paths.ts";
import { DURABLE_PAUSE_REASON } from "./recovery.ts";
import { terminateProcessTree } from "./process-tree.ts";
import {
	runCwd,
	withChildConfigHome,
	type RunBackend,
	type RunContext,
	type RunFailure,
	type RunRequest,
	type RunResult,
} from "./run.ts";
import { SANDBOX_MODE_FLAG } from "./constants.ts";

export interface WorkerLaunch {
	type: "start";
	request: RunRequest;
	context: Omit<RunContext, "signal" | "onStatus">;
	directory: string;
	requestId: string;
}

export const runConversationBatch: RunBackend = (requests, context) =>
	Promise.all(requests.map((request) => runConversation(request, context)));

function runConversation(request: RunRequest, context: RunContext): Promise<RunResult> {
	const paths = runPaths(
		context.sessionFile,
		context.sessionId,
		context.runId,
		request.agent.config.name,
		request.index,
	);
	const directory = join(paths.dir, `${sanitizeSegment(request.agent.config.name)}-${request.index}.durable`);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const deadlineAt = context.deadlineAt ?? Date.now() + context.timeoutMs;
	const failure = (error: string, kind: RunFailure): RunResult => ({
		agent: request.agent.config.name,
		scope: request.agent.scope,
		backend: "durable",
		ok: false,
		output: "",
		error,
		failure: kind,
	});
	if (deadlineAt <= Date.now())
		return Promise.resolve(failure("Subagent lifetime expired before recovery", "timeout"));
	if (context.signal?.aborted && context.signal.reason !== DURABLE_PAUSE_REASON)
		return Promise.resolve(failure("Cancelled before admission", "cancelled"));
	const nightRun = context.nightRun ?? (request.night ? readActiveNightRun() : undefined);
	if (request.night && !nightRun)
		return Promise.resolve(
			failure("Approved night contract unavailable; refusing to resume without its policies", "launch"),
		);
	const nightSnapshot = request.night ? join(directory, "night-contract.json") : undefined;
	if (nightSnapshot) writeFileSync(nightSnapshot, JSON.stringify(nightRun), { mode: 0o600 });
	const base = request.night ? nightChildEnv(nightRun) : process.env;
	const configHome = request.night ? undefined : prepareConfigHome(join(directory, "config-home")).path;
	const args = [fileURLToPath(new URL("./worker-bootstrap.mjs", import.meta.url))];
	if (request.agent.config.sandbox) args.push(`--${SANDBOX_MODE_FLAG}`, request.agent.config.sandbox);
	const child = spawn(process.execPath, args, {
		cwd: runCwd(request, context),
		detached: true,
		// Never leave an unread stdin pipe open. Pi's native tools do not need it.
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		env: {
			...withChildConfigHome(configHome, base),
			...(nightSnapshot ? { PI_DURABLE_NIGHT_RUN_FILE: nightSnapshot } : {}),
			PI_CODE_MODE_SUBAGENT: "1",
		},
	});
	return watchWorker(child, request, nightRun ? { ...context, nightRun } : context, directory, deadlineAt, failure);
}

function watchWorker(
	child: ChildProcess,
	request: RunRequest,
	context: RunContext,
	directory: string,
	deadlineAt: number,
	failure: (error: string, kind: RunFailure) => RunResult,
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		let result: RunResult | undefined;
		let stderr = "";
		let stopped: RunFailure | "pause" | undefined;
		let finished = false;
		let fallback: ReturnType<typeof setTimeout> | undefined;
		let grace: ReturnType<typeof setTimeout> | undefined;
		let tree: ReturnType<typeof terminateProcessTree> | undefined;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (fallback) clearTimeout(fallback);
			if (grace) clearTimeout(grace);
			tree?.cancel();
			context.signal?.removeEventListener("abort", onAbort);
			if (stopped === "pause") {
				reject(new Error(DURABLE_PAUSE_REASON));
				return;
			}
			const final = stopped
				? failure(`Subagent ${stopped}`, stopped)
				: (result ?? failure(stderr || "Durable worker exited without a result", "launch"));
			context.onStatus?.(request.index, {
				state: final.ok ? "done" : "failed",
				...(final.outputPath ? { outputPath: final.outputPath } : {}),
			});
			resolve(final);
		};
		const stop = (reason: RunFailure | "pause") => {
			if (stopped || finished) return;
			stopped = reason;
			if (child.connected) child.send({ type: reason === "pause" ? "pause" : "cancel" }, () => {});
			// Give Harness.close/abort time to commit, then terminate the entire kernel/tool group.
			grace = setTimeout(() => {
				tree = terminateProcessTree(child);
			}, 2_000);
			fallback = setTimeout(finish, 5_000);
		};
		const onAbort = () => stop(context.signal?.reason === DURABLE_PAUSE_REASON ? "pause" : "cancelled");
		const timer = setTimeout(() => stop("timeout"), Math.max(1, deadlineAt - Date.now()));
		child.stderr?.on("data", (chunk) => {
			stderr = (stderr + String(chunk)).slice(-16_384);
		});
		child.stdout?.resume();
		child.once("error", (error) => {
			stderr = error.message;
			finish();
		});
		child.once("close", finish);
		child.on("message", (message: unknown) => {
			if (!message || typeof message !== "object") return;
			const packet = message as { type?: string; result?: RunResult };
			if (packet.type === "result" && packet.result) result = packet.result;
			if (packet.type === "paused") stopped = "pause";
		});
		context.signal?.addEventListener("abort", onAbort, { once: true });
		const { signal: _signal, onStatus: _status, ...snapshot } = context;
		const launch: WorkerLaunch = {
			type: "start",
			request,
			context: { ...snapshot, deadlineAt },
			directory,
			requestId: `${context.runId}:${request.index}`,
		};
		if (child.connected)
			child.send(launch, (error) => {
				if (error && !finished) {
					stderr = error.message;
					stop("launch");
				}
			});
		context.onStatus?.(request.index, { state: "running" });
		if (context.signal?.aborted) onAbort();
	});
}
