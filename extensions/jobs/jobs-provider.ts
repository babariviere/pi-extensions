/** Session-owned shell jobs. No QuickJS promise or tool-call abort signal owns a job. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { terminateProcessTree } from "../subagents/process-tree.ts";
import type { ActionDescriptor, ActionContext, ActionProvider, ActionListRequest } from "../shared/action-tools.ts";
import type { JobsStorage } from "./job-storage.ts";

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

type JobState = "running" | "done" | "failed" | "cancelled" | "interrupted";
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
	child?: ChildProcess;
	output?: WriteStream;
	finished: Promise<void>;
	resolve(): void;
	claimed: boolean;
	waiters: number;
	loggedBytes: number;
	finishedWriting: boolean;
	timer?: ReturnType<typeof setTimeout>;
	dispose?(): void;
}
export type JobCompletionSink = (jobs: JobSnapshot[]) => void;

const jobOutputSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		name: { type: "string" },
		state: { type: "string", enum: ["running", "done", "failed", "cancelled", "interrupted"] },
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
		description: "Launch a named command, capturing stdout/stderr in outputPath.",
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
		description: "Running and recent jobs with outputPath; does not claim completions.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		outputSchema: { type: "array", items: jobOutputSchema },
	},
	{
		name: "status",
		description: "Alias for list.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		outputSchema: { type: "array", items: jobOutputSchema },
	},
	{
		name: "wait",
		description:
			"Optional bounded wait (30s default, 120s max), with outputPath. A terminal result claims completion and suppresses its wake-up. Cancelling wait leaves the job running.",
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
		description: "Cancel a job and its subprocess group; no completion wake-up.",
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
		"Session-owned shell jobs for long-running commands only. Use bash for short commands. If only job completion remains, end your turn, even when your next step depends on it; completion wakes you. Do not poll or use shell sleeps.";
	readonly instructions = [
		"Use codemode with Promise.allSettled for independent tool calls; parallelism alone does not require jobs.",
		"Jobs survive turn end and reload, not shutdown; maximum lifetime is 2 hours. File-backed sessions retain handles and logs. Crash recovery marks unfinished jobs interrupted, never reruns commands. For an unknown handle, list once; do not retry it.",
		"Unclaimed completions are grouped while idle. Terminal waits claim results; list/status and log reads do not. Aborting wait leaves the job running and unclaimed.",
		"Let jobs capture stdout/stderr. Use read or bash with rg/tail on outputPath. Persistent logs survive shutdown; in-memory sessions use temporary logs. Every launch requires the sandbox extension.",
	].join("\n");
	readonly #jobs = new Map<string, Job>();
	#closing = false;
	#closed = false;
	#closePromise?: Promise<void>;
	#attachment = 0;
	#active = true;
	#storageError?: Error;
	#announcementTimer?: ReturnType<typeof setTimeout>;
	#windowStartedAt?: number;
	wrapCommand: (command: string) => Promise<string>;
	sink: JobCompletionSink;
	canAnnounce: () => boolean;
	onError: (error: Error) => void = () => {};
	readonly onChange: () => void;
	readonly timing: AnnouncementTiming;

	constructor(
		wrapCommand: (command: string) => Promise<string>,
		sink: JobCompletionSink,
		canAnnounce = () => true,
		onChange = () => {},
		timing: Partial<AnnouncementTiming> = {},
		readonly storage?: JobsStorage,
	) {
		this.wrapCommand = wrapCommand;
		this.sink = sink;
		this.canAnnounce = canAnnounce;
		this.onChange = onChange;
		this.timing = { ...DEFAULT_ANNOUNCEMENT_TIMING, ...timing };
		if (storage) {
			for (const { snapshot, claimed } of storage.load()) {
				const recovered = { ...snapshot };
				if (recovered.state === "running") {
					recovered.state = "interrupted";
					recovered.endedAt = Date.now();
					recovered.exitCode = null;
					recovered.error =
						"Pi stopped before completion was recorded. The command may have produced side effects or left subprocesses alive. Inspect output before starting it again; it was not rerun.";
				} else if (!recovered.endedAt) recovered.endedAt = Date.now();
				this.#jobs.set(recovered.id, {
					...recovered,
					claimed,
					finished: Promise.resolve(),
					resolve() {},
					waiters: 0,
					loggedBytes: 0,
					finishedWriting: true,
				});
			}
			this.#prune();
			this.#persist();
		}
	}

	/** Rebind runtime services after reload. Existing processes keep their original command and deadline. */
	attach(
		wrapCommand: JobsProvider["wrapCommand"],
		sink: JobCompletionSink,
		canAnnounce: () => boolean,
		onError: (error: Error) => void,
	): void {
		this.#attachment++;
		this.#active = true;
		this.wrapCommand = wrapCommand;
		this.sink = sink;
		this.canAnnounce = canAnnounce;
		this.onError = onError;
		if (this.#storageError) onError(this.#storageError);
		this.settle();
	}

	/** Detach stale runtime callbacks without cancelling session-owned jobs. */
	suspend(): void {
		this.#attachment++;
		this.#active = false;
		this.wrapCommand = async () => {
			throw new Error("Jobs runtime is detached");
		};
		this.sink = () => {};
		this.canAnnounce = () => false;
		this.onError = () => {};
		if (this.#announcementTimer) clearTimeout(this.#announcementTimer);
		this.#announcementTimer = undefined;
		this.#windowStartedAt = undefined;
	}

	#persist(): void {
		if (this.#closed || !this.storage) return;
		if (this.#storageError) throw this.#storageError;
		try {
			this.storage.save(
				[...this.#jobs.values()].map((job) => ({ snapshot: this.#snapshot(job), claimed: job.claimed })),
			);
		} catch (cause) {
			this.#storageError = new Error(
				"Jobs storage failed; new launches and completion acknowledgements are disabled",
				{ cause },
			);
			try {
				this.onError(this.#storageError);
			} catch {}
			throw this.#storageError;
		}
	}

	#persistEvent(): void {
		try {
			this.#persist();
		} catch {
			/* Reported through onError; never throw from process callbacks. */
		}
	}

	running(): JobSnapshot[] {
		return [...this.#jobs.values()].filter((job) => job.state === "running").map((job) => this.#snapshot(job));
	}

	/** Announce pending unclaimed exits now, if the parent can take them. */
	flushCompletions(): void {
		if (this.#announcementTimer) clearTimeout(this.#announcementTimer);
		this.#announcementTimer = undefined;
		if (this.#closing || this.#storageError || !this.canAnnounce()) return;
		const completed = this.#pending();
		this.#windowStartedAt = undefined;
		if (!completed.length) return;
		for (const job of completed) job.claimed = true;
		try {
			this.#persist();
		} catch {
			return;
		}
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
		if (this.#closing || !this.#active || this.#storageError || !this.#pending().length) return;
		this.#windowStartedAt = Date.now();
		this.#scheduleAnnouncement();
	}

	#pending(): Job[] {
		return [...this.#jobs.values()].filter((job) => job.finishedWriting && !job.claimed && job.waiters === 0);
	}

	/** (Re)arm the announcement: wait for a quiet period, capped from the start of the window. */
	#scheduleAnnouncement(): void {
		if (this.#closing || !this.#active || this.#storageError) return;
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
		if (this.#closed) throw new Error("Jobs session is closed");
		const attachment = this.#attachment;
		if (name === "start") {
			const checkLaunch = () => {
				if (this.#closing || !this.#active || attachment !== this.#attachment)
					throw new Error("Jobs runtime is shutting down or detached");
				if (this.#storageError) throw this.#storageError;
				if ([...this.#jobs.values()].filter((job) => job.state === "running").length >= MAX_JOBS)
					throw new Error(`At most ${MAX_JOBS} jobs may run at once`);
			};
			checkLaunch();
			if (
				typeof args.name !== "string" ||
				!args.name.trim() ||
				typeof args.command !== "string" ||
				!args.command.trim()
			)
				throw new Error("jobs.start requires non-empty name and command");
			if (args.command.includes("\0")) throw new Error("jobs.start command cannot contain NUL characters");
			const cwd = args.cwd ?? context.cwd;
			if (typeof cwd !== "string" || !isAbsolute(cwd) || !(await stat(cwd).catch(() => undefined))?.isDirectory())
				throw new Error("jobs.start cwd must be an existing absolute directory");
			const command = await this.wrapCommand(args.command);
			checkLaunch();
			if (command.includes("\0")) throw new Error("Sandbox-wrapped command cannot contain NUL characters");
			const id = randomUUID();
			const dir = this.storage ? undefined : await mkdtemp(join(tmpdir(), "pi-job-"));
			try {
				checkLaunch();
			} catch (error) {
				if (dir) await rm(dir, { recursive: true, force: true });
				throw error;
			}
			const capture = this.storage?.createOutput(id);
			const outputPath = capture?.outputPath ?? join(dir!, "output.log");
			let resolve = () => {};
			const finished = new Promise<void>((done) => {
				resolve = done;
			});
			const job: Job = {
				id,
				name: args.name,
				state: "running",
				startedAt: Date.now(),
				outputPath,
				finished,
				resolve,
				claimed: false,
				waiters: 0,
				loggedBytes: 0,
				finishedWriting: false,
			};
			this.#jobs.set(job.id, job);
			try {
				this.#persist();
			} catch (error) {
				this.#jobs.delete(job.id);
				if (capture) closeSync(capture.fd);
				if (dir) await rm(dir, { recursive: true, force: true });
				throw error;
			}
			// Admission is committed before the shell can produce any side effects.
			let output: WriteStream;
			let child: ChildProcess;
			try {
				output = createWriteStream(outputPath, capture ? { fd: capture.fd } : { flags: "a", mode: 0o600 });
				job.output = output;
				child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
			} catch (error) {
				// A synchronous setup failure has no shell to emit exit/close events.
				if (job.output) {
					job.output.on("error", () => {});
					job.output.destroy();
				} else if (capture) closeSync(capture.fd);
				job.state = "failed";
				job.endedAt = Date.now();
				job.exitCode = null;
				job.error = error instanceof Error ? error.message : String(error);
				job.finishedWriting = true;
				job.resolve();
				this.#prune();
				this.#persistEvent();
				this.#scheduleAnnouncement();
				throw error;
			}
			job.child = child;
			job.output = output;
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
				this.#prune();
				this.#persistEvent();
				job.resolve();
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
			job.dispose = () => {
				if (drainTimer) clearTimeout(drainTimer);
				if (job.timer) clearTimeout(job.timer);
				child.stdout?.destroy();
				child.stderr?.destroy();
				output.destroy();
			};
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
				try {
					this.#persist();
				} finally {
					if (job.child) terminateProcessTree(job.child);
				}
			}
			return this.#snapshot(job);
		}
		if (name === "wait") {
			if (context.signal?.aborted) return this.#snapshot(job);
			if (!job.finishedWriting) {
				const waitMs = bounded(args.waitMs, 30_000, 120_000);
				context.update?.(
					`Waiting up to ${waitMs}ms for ${job.name} (${job.id}). Output: ${job.outputPath}. End your turn if only completion remains.`,
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
				} finally {
					job.waiters--;
					if (timer) clearTimeout(timer);
					if (abort) signal?.removeEventListener("abort", abort);
					if (this.#pending().length) this.#scheduleAnnouncement();
				}
			}
			if (job.finishedWriting && !context.signal?.aborted && this.#active && attachment === this.#attachment) {
				job.claimed = true;
				this.#persist();
			}
			return this.#snapshot(job);
		}
		throw new Error(`Unknown jobs action: ${name}`);
	}

	#get(id: unknown): Job {
		const job = typeof id === "string" ? this.#jobs.get(id) : undefined;
		if (!job)
			throw new Error(
				`Unknown job: ${String(id)}. Use jobs({ action: "list" }) to find current handles; older handles may have been pruned. Do not retry this handle.`,
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
		const finished = [...this.#jobs.values()].filter((job) => job.finishedWriting && job.waiters === 0);
		for (const job of finished.slice(0, Math.max(0, finished.length - MAX_HISTORY))) this.#jobs.delete(job.id);
	}
	close(): Promise<void> {
		return (this.#closePromise ??= this.#close());
	}
	async #close(): Promise<void> {
		this.#closing = true;
		this.suspend();
		const unfinished = [...this.#jobs.values()].filter((job) => !job.finishedWriting);
		for (const job of unfinished) {
			if (job.state === "running") {
				job.state = "cancelled";
				job.claimed = true;
			}
		}
		this.#persistEvent();
		for (const job of unfinished) if (job.child) terminateProcessTree(job.child);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.all(unfinished.map((job) => job.finished)),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 5_000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		for (const job of unfinished) {
			job.dispose?.();
			if (!job.finishedWriting) {
				job.endedAt ??= Date.now();
				job.finishedWriting = true;
				job.resolve();
			}
		}
		this.#persistEvent();
		this.#closed = true;
		if (this.storage) this.storage.close();
		else
			await Promise.allSettled(
				[...this.#jobs.values()].map((job) => rm(join(job.outputPath, ".."), { recursive: true, force: true })),
			);
		this.#jobs.clear();
	}
}
