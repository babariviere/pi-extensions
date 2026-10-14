/** Session-owned shell jobs. No QuickJS promise or tool-call abort signal owns a job. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { terminateProcessTree } from "../subagents/process-tree.ts";
import type { ActionDescriptor, ActionContext, ActionProvider, ActionListRequest } from "../shared/action-tools.ts";

const MAX_JOBS = 20;
const MAX_HISTORY = 50;
const MAX_LIFETIME_MS = 2 * 60 * 60_000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
/**
 * After the shell exits, how long to keep reading stdio before settling. Background descendants
 * (`server &`, daemons) inherit the pipes and would otherwise keep the job running forever.
 */
const STDIO_DRAIN_MS = 500;

/**
 * Completion grouping. A quiet window that resets on each completion, bounded by a hard cap.
 * While jobs from the same batch are still running, a successful completion is held until the
 * batch finishes (bounded by batchMaxDelayMs). Failures skip the batch hold.
 */
export interface AnnouncementTiming {
	/** Quiet period after the latest completion before announcing. */
	quietMs: number;
	/** Jobs started within this window of a pending job belong to its batch. */
	batchWindowMs: number;
	/** Maximum hold, from the first pending completion (or turn settle), while batch jobs still run. */
	batchMaxDelayMs: number;
	/** Maximum delay from the first pending completion (or turn settle) when nothing holds the batch. */
	maxDelayMs: number;
}
export const DEFAULT_ANNOUNCEMENT_TIMING: AnnouncementTiming = {
	quietMs: 2_000,
	batchWindowMs: 5_000,
	batchMaxDelayMs: 60_000,
	maxDelayMs: 10_000,
};

type JobState = "running" | "done" | "failed" | "cancelled";
export interface JobSnapshot {
	id: string;
	name: string;
	state: JobState;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	error?: string;
	outputPath: string;
	logTruncated?: boolean;
}
interface Job extends JobSnapshot {
	child: ChildProcess;
	output: WriteStream;
	finished: Promise<void>;
	resolve(): void;
	claimed: boolean;
	waiters: number;
	loggedBytes: number;
	finishedWriting: boolean;
	timer?: ReturnType<typeof setTimeout>;
}
export type JobCompletionSink = (jobs: JobSnapshot[]) => void;

const jobOutputSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		name: { type: "string" },
		state: { type: "string", enum: ["running", "done", "failed", "cancelled"] },
		startedAt: { type: "number" },
		endedAt: { type: "number" },
		exitCode: { type: ["number", "null"] },
		error: { type: "string" },
		outputPath: { type: "string" },
		logTruncated: { type: "boolean" },
	},
	required: ["id", "name", "state", "startedAt", "outputPath"],
};

const descriptors: ActionDescriptor[] = [
	{
		name: "start",
		description:
			"Start a named long-running shell command only. Use bash for short commands and codemode to run independent tool calls in parallel. Unclaimed completions automatically notify the idle parent in one batch. Runs until exit, stop, session shutdown, or the 2-hour cap. Output is stored in a temporary file.",
		inputSchema: {
			type: "object",
			properties: { name: { type: "string" }, command: { type: "string" }, cwd: { type: "string" } },
			required: ["name", "command"],
			additionalProperties: false,
		},
		outputSchema: jobOutputSchema,
	},
	{
		name: "list",
		description:
			"List running and recent shell jobs, including outputPath. Handles are local to this session runtime, not durable across reloads. Does not claim completions.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		outputSchema: { type: "array", items: jobOutputSchema },
	},
	{
		name: "status",
		description: "Alias for list: running and recent shell jobs, including outputPath. Does not claim completions.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		outputSchema: { type: "array", items: jobOutputSchema },
	},
	{
		name: "wait",
		description:
			"Legacy bounded wait (default 30 seconds). Prefer ending your turn: even if the next step depends on this job, completion automatically wakes you. Never repeat wait when it returns running. Includes outputPath. A terminal wait claims its result and suppresses the completion wake-up. Cancelling the wait does not stop the job.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" }, waitMs: { type: "number" } },
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: jobOutputSchema,
	},
	{
		name: "stop",
		description: "Stop a running job and its subprocess group. Stopped jobs never trigger a completion wake-up.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: jobOutputSchema,
	},
];

for (const descriptor of descriptors) {
	const readOnly = ["list", "status", "wait"].includes(descriptor.name);
	descriptor.annotations = {
		readOnlyHint: readOnly,
		destructiveHint: !readOnly,
		idempotentHint: ["list", "status", "stop"].includes(descriptor.name),
		openWorldHint: descriptor.name === "start",
	};
}

const bounded = (value: unknown, fallback: number, max: number): number =>
	typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : fallback;

export class JobsProvider implements ActionProvider {
	readonly name = "jobs";
	readonly description =
		"Session-owned background shell jobs for long-running commands only. Use bash for short commands and codemode to run independent tool calls in parallel. If only job completion remains, end your turn, even when your next step depends on it. Completion automatically wakes you; do not poll wait/list/status or sleep. Results include outputPath for reading or searching output files.";
	readonly instructions = [
		"Use jobs only for long-running shell commands. Use bash for short commands and codemode with Promise.allSettled to run independent tool calls in parallel. Parallelism alone is not a reason to start jobs.",
		'Use tools.jobs({ action: "start", name, command, cwd? }) for long-running shell work that should outlive a tool call.',
		"Jobs remain owned by this session and stop on explicit jobs.stop, shutdown/reload, command exit, or the two-hour cap. Ending the agent turn does not stop jobs.",
		"After starting a job, do independent work. If only job completion remains, end your turn, even when your next step depends on it. Unclaimed completion automatically wakes you to continue. Do not repeatedly call wait, list, status, sleep, or read output files to poll progress.",
		'Use tools.jobs({ action: "list" }) to recover current handles; status is an alias. Handles are runtime-local and disappear on reload/shutdown. An unknown handle cannot be waited on; list once, then use the recorded output path if it still exists. Do not retry an unknown handle.',
		"Start, list, status, and wait return outputPath. Let jobs capture stdout/stderr instead of redirecting them to another file, so notifications point at useful logs. Use read or bash with rg/tail after completion or to diagnose a running job; do not poll the file.",
		"wait is retained for compatibility and terminal-result acknowledgement, not as a polling workflow. If it returns running, do other work or end your turn, never wait again. Aborting a wait leaves the session-owned job running and unclaimed.",
		"Pending unclaimed completions wake the idle parent together in one follow-up listing all finished jobs and their output paths, sent after a short quiet period so jobs finishing close together are grouped. Terminal waits suppress that wake-up; status calls and direct file reads do not. Stopped jobs never wake it.",
		"Output files are temporary and disappear during session cleanup. The sandbox extension is required for every launch.",
	].join("\n");
	readonly #jobs = new Map<string, Job>();
	#closing = false;
	#announcementTimer?: ReturnType<typeof setTimeout>;
	#windowStartedAt?: number;
	readonly wrapCommand: (command: string) => Promise<string>;
	readonly sink: JobCompletionSink;
	readonly canAnnounce: () => boolean;
	readonly onChange: () => void;
	readonly timing: AnnouncementTiming;

	constructor(
		wrapCommand: (command: string) => Promise<string>,
		sink: JobCompletionSink,
		canAnnounce = () => true,
		onChange = () => {},
		timing: Partial<AnnouncementTiming> = {},
	) {
		this.wrapCommand = wrapCommand;
		this.sink = sink;
		this.canAnnounce = canAnnounce;
		this.onChange = onChange;
		this.timing = { ...DEFAULT_ANNOUNCEMENT_TIMING, ...timing };
	}

	running(): JobSnapshot[] {
		return [...this.#jobs.values()].filter((job) => job.state === "running").map((job) => this.#snapshot(job));
	}

	/** Announce pending unclaimed exits now, if the parent can take them. */
	flushCompletions(): void {
		if (this.#announcementTimer) clearTimeout(this.#announcementTimer);
		this.#announcementTimer = undefined;
		if (this.#closing || !this.canAnnounce()) return;
		const completed = this.#pending();
		this.#windowStartedAt = undefined;
		if (!completed.length) return;
		for (const job of completed) job.claimed = true;
		try {
			this.sink(completed.map((job) => this.#snapshot(job)));
		} catch {
			// A notification failure must not crash Pi.
		}
	}

	/**
	 * The parent finished its turn. Restart the grouping window so jobs exiting
	 * right after the turn join completions collected during it.
	 */
	settle(): void {
		if (this.#closing || !this.#pending().length) return;
		this.#windowStartedAt = Date.now();
		this.#scheduleAnnouncement();
	}

	#pending(): Job[] {
		return [...this.#jobs.values()].filter((job) => job.finishedWriting && !job.claimed && job.waiters === 0);
	}

	/** (Re)arm the announcement: wait for a quiet period, capped from the start of the window. */
	#scheduleAnnouncement(): void {
		if (this.#closing) return;
		if (this.#announcementTimer) clearTimeout(this.#announcementTimer);
		const now = Date.now();
		this.#windowStartedAt ??= now;
		const pending = this.#pending();
		const { quietMs, batchWindowMs, batchMaxDelayMs, maxDelayMs } = this.timing;
		const batchRunning = [...this.#jobs.values()].some(
			(job) =>
				job.state === "running" &&
				pending.some((done) => Math.abs(done.startedAt - job.startedAt) <= batchWindowMs),
		);
		const failed = pending.some((job) => job.state !== "done");
		// Hold successes until the rest of their batch exits (its completions re-arm this timer).
		// A failure is actionable now, so it uses the normal quiet window instead.
		const delay =
			batchRunning && !failed
				? this.#windowStartedAt + batchMaxDelayMs - now
				: Math.min(quietMs, this.#windowStartedAt + maxDelayMs - now);
		this.#announcementTimer = setTimeout(() => this.flushCompletions(), Math.max(0, delay));
		this.#announcementTimer.unref?.();
	}

	async list(_request: ActionListRequest, _context: ActionContext): Promise<ActionDescriptor[]> {
		return descriptors;
	}
	async describe(name: string, _context: ActionContext): Promise<ActionDescriptor | undefined> {
		return descriptors.find((item) => item.name === name);
	}

	async invoke(name: string, args: Record<string, unknown>, context: ActionContext): Promise<unknown> {
		if (name === "start") {
			if (this.#closing) throw new Error("Session is shutting down");
			if (
				typeof args.name !== "string" ||
				!args.name.trim() ||
				typeof args.command !== "string" ||
				!args.command.trim()
			)
				throw new Error("jobs.start requires non-empty name and command");
			if ([...this.#jobs.values()].filter((job) => job.state === "running").length >= MAX_JOBS)
				throw new Error(`At most ${MAX_JOBS} jobs may run at once`);
			const cwd = args.cwd ?? context.cwd;
			if (typeof cwd !== "string" || !isAbsolute(cwd) || !(await stat(cwd).catch(() => undefined))?.isDirectory())
				throw new Error("jobs.start cwd must be an existing absolute directory");
			const command = await this.wrapCommand(args.command);
			if (this.#closing) throw new Error("Session is shutting down");
			const dir = await mkdtemp(join(tmpdir(), "pi-job-"));
			if (this.#closing) {
				await rm(dir, { recursive: true, force: true });
				throw new Error("Session is shutting down");
			}
			const outputPath = join(dir, "output.log");
			const output = createWriteStream(outputPath, { flags: "a" });
			const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
			let resolve = () => {};
			const finished = new Promise<void>((done) => {
				resolve = done;
			});
			const job: Job = {
				id: randomUUID(),
				name: args.name,
				state: "running",
				startedAt: Date.now(),
				outputPath,
				child,
				output,
				finished,
				resolve,
				claimed: false,
				waiters: 0,
				loggedBytes: 0,
				finishedWriting: false,
			};
			const recordOutput = (chunk: Buffer) => {
				const remaining = MAX_LOG_BYTES - job.loggedBytes;
				if (remaining > 0) {
					const written = chunk.subarray(0, remaining);
					job.loggedBytes += written.length;
					output.write(written);
				}
				if (chunk.length > remaining) job.logTruncated = true;
			};
			child.stdout?.on("data", recordOutput);
			child.stderr?.on("data", recordOutput);
			let finalized = false;
			const finalize = () => {
				if (finalized || !job.endedAt) return;
				finalized = true;
				job.finishedWriting = true;
				job.resolve();
				this.#prune();
				this.#scheduleAnnouncement();
			};
			output.on("error", (error) => {
				job.error = `Output file: ${error.message}`;
				if (job.state === "done") job.state = "failed";
				finalize();
			});
			job.timer = setTimeout(() => {
				job.error = "Job exceeded the 2-hour lifetime cap";
				terminateProcessTree(child);
			}, MAX_LIFETIME_MS);
			job.timer.unref?.();
			this.#jobs.set(job.id, job);
			this.onChange();
			const settle = (code: number | null, error?: Error) => {
				if (job.endedAt) return;
				if (job.timer) clearTimeout(job.timer);
				if (drainTimer) clearTimeout(drainTimer);
				job.endedAt = Date.now();
				job.exitCode = code;
				if (error) job.error = error.message;
				if (job.state !== "cancelled") job.state = code === 0 && !job.error ? "done" : "failed";
				this.onChange();
				if (output.destroyed) finalize();
				else output.end(finalize);
			};
			child.on("error", (error) => settle(null, error));
			child.on("close", (code) => settle(code));
			// `close` waits for every pipe holder. Once the shell itself exited, give its output a
			// short grace period, then stop reading so lingering descendants cannot hold the job open.
			let drainTimer: ReturnType<typeof setTimeout> | undefined;
			child.on("exit", (code) => {
				drainTimer = setTimeout(() => {
					child.stdout?.destroy();
					child.stderr?.destroy();
					settle(code);
				}, STDIO_DRAIN_MS);
				drainTimer.unref?.();
			});
			return this.#snapshot(job);
		}
		if (name === "list" || name === "status") return [...this.#jobs.values()].map((job) => this.#snapshot(job));
		if (name !== "stop" && name !== "wait") throw new Error(`Unknown jobs action: ${name}`);
		const job = this.#get(args.id);
		if (name === "stop") {
			if (job.state === "running") {
				job.state = "cancelled";
				job.claimed = true;
				this.onChange();
				terminateProcessTree(job.child);
			}
			return this.#snapshot(job);
		}
		if (name === "wait") {
			if (context.signal?.aborted) return this.#snapshot(job);
			if (!job.finishedWriting) {
				const waitMs = bounded(args.waitMs, 30_000, 120_000);
				context.update?.(
					`Waiting up to ${waitMs}ms for ${job.name} (${job.id}). Output: ${job.outputPath}. Prefer ending your turn; completion automatically wakes you.`,
				);
				job.waiters++;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const signal = context.signal;
				let abort: (() => void) | undefined;
				try {
					await new Promise<void>((resolve) => {
						abort = resolve;
						signal?.addEventListener("abort", abort, { once: true });
						timer = setTimeout(resolve, waitMs);
						void job.finished.then(resolve);
						if (signal?.aborted) abort();
					});
					if (job.finishedWriting && !signal?.aborted) job.claimed = true;
				} finally {
					job.waiters--;
					if (timer) clearTimeout(timer);
					if (abort) signal?.removeEventListener("abort", abort);
					if (this.#pending().length) this.#scheduleAnnouncement();
				}
			}
			if (job.finishedWriting && !context.signal?.aborted) job.claimed = true;
			return this.#snapshot(job);
		}
		throw new Error(`Unknown jobs action: ${name}`);
	}

	#get(id: unknown): Job {
		const job = typeof id === "string" ? this.#jobs.get(id) : undefined;
		if (!job)
			throw new Error(
				`Unknown job: ${String(id)}. Use jobs({ action: "list" }) to find current handles; jobs do not survive reload/shutdown. Do not retry this handle.`,
			);
		return job;
	}
	#snapshot(job: Job): JobSnapshot {
		return {
			id: job.id,
			name: job.name,
			state: job.state,
			startedAt: job.startedAt,
			outputPath: job.outputPath,
			...(job.logTruncated ? { logTruncated: true } : {}),
			...(job.endedAt
				? { endedAt: job.endedAt, exitCode: job.exitCode, ...(job.error ? { error: job.error } : {}) }
				: {}),
		};
	}
	#prune(): void {
		const finished = [...this.#jobs.values()].filter((job) => job.endedAt);
		for (const job of finished.slice(0, Math.max(0, finished.length - MAX_HISTORY))) this.#jobs.delete(job.id);
	}
	async close(): Promise<void> {
		this.#closing = true;
		if (this.#announcementTimer) clearTimeout(this.#announcementTimer);
		this.#announcementTimer = undefined;
		this.#windowStartedAt = undefined;
		const running = [...this.#jobs.values()].filter((job) => job.state === "running");
		for (const job of running) {
			job.state = "cancelled";
			job.claimed = true;
			terminateProcessTree(job.child);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.all(running.map((job) => job.finished)),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 5_000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		await Promise.allSettled(
			[...this.#jobs.values()].map((job) => rm(join(job.outputPath, ".."), { recursive: true, force: true })),
		);
		this.#jobs.clear();
	}
}
