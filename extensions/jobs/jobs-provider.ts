/** Session-owned shell jobs. No QuickJS promise or tool-call abort signal owns a job. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { terminateProcessTree } from "../subagents/process-tree.ts";
import type { ActionDescriptor, ActionContext, ActionProvider, ActionListRequest } from "../shared/action-tools.ts";

const MAX_JOBS = 20;
const MAX_HISTORY = 50;
const MAX_LIFETIME_MS = 2 * 60 * 60_000;
const MAX_LOG_CHARS = 20_000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const ANNOUNCE_DELAY_MS = 150;

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
			"Start a named shell command for long-running or parallel work. Prefer bash for short commands. Unclaimed completions automatically notify the idle parent in one batch. Runs until exit, stop, session shutdown, or the 2-hour cap. Output is stored in a temporary file.",
		inputSchema: {
			type: "object",
			properties: { name: { type: "string" }, command: { type: "string" }, cwd: { type: "string" } },
			required: ["name", "command"],
			additionalProperties: false,
		},
		outputSchema: jobOutputSchema,
	},
	{
		name: "status",
		description: "List running and recent shell jobs (without their output).",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		outputSchema: { type: "array", items: jobOutputSchema },
	},
	{
		name: "wait",
		description:
			"Wait only when the next step depends on this job; otherwise rely on automatic completion notifications, not polling. Returns running after waitMs (default 30 seconds). A terminal wait claims its result and suppresses the completion wake-up.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" }, waitMs: { type: "number" } },
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: jobOutputSchema,
	},
	{
		name: "logs",
		description:
			"Inspect a completed job's output, or diagnose a running job when needed. Avoid polling running logs. Reads the last maxChars (default 4000, max 20000). A terminal log read claims its result and suppresses the completion wake-up.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" }, maxChars: { type: "number" } },
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: { ...jobOutputSchema.properties, text: { type: "string" }, truncated: { type: "boolean" } },
			required: [...jobOutputSchema.required, "text", "truncated"],
		},
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
	const readOnly = ["status", "wait", "logs"].includes(descriptor.name);
	descriptor.annotations = {
		readOnlyHint: readOnly,
		destructiveHint: !readOnly,
		idempotentHint: ["status", "logs", "stop"].includes(descriptor.name),
		openWorldHint: descriptor.name === "start",
	};
}

const bounded = (value: unknown, fallback: number, max: number): number =>
	typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : fallback;

export class JobsProvider implements ActionProvider {
	readonly name = "jobs";
	readonly description =
		"Session-owned background shell jobs. Prefer bash for short commands. Start long-running or parallel work, do other work, and rely on automatic completion notifications instead of polling wait/logs.";
	readonly instructions = [
		"Prefer bash for short commands. Use jobs for long-running or parallel shell work.",
		'Use tools.jobs({ action: "start", name, command, cwd? }) for shell work that should outlive a tool call.',
		"Jobs remain owned by this session and stop on shutdown/reload, cancellation, exit, or the two-hour cap.",
		"After starting a job, do other work or finish the turn. Do not repeatedly call wait, status, or logs to poll progress.",
		'Use tools.jobs({ action: "wait", id, waitMs? }) only when the next step depends on completion. Use tools.jobs({ action: "logs", id }) to inspect output after completion or diagnose a running job when needed.',
		"Pending unclaimed completions wake the idle parent together in one follow-up listing all finished jobs. Terminal waits and log reads suppress that wake-up; running log reads do not. Stopped jobs never wake it.",
		"Output files are temporary and disappear during session cleanup. The sandbox extension is required for every launch.",
	].join("\n");
	readonly #jobs = new Map<string, Job>();
	#closing = false;
	#announcementTimer?: ReturnType<typeof setTimeout>;
	readonly wrapCommand: (command: string) => Promise<string>;
	readonly sink: JobCompletionSink;
	readonly canAnnounce: () => boolean;
	readonly onChange: () => void;

	constructor(
		wrapCommand: (command: string) => Promise<string>,
		sink: JobCompletionSink,
		canAnnounce = () => true,
		onChange = () => {},
	) {
		this.wrapCommand = wrapCommand;
		this.sink = sink;
		this.canAnnounce = canAnnounce;
		this.onChange = onChange;
	}

	running(): JobSnapshot[] {
		return [...this.#jobs.values()].filter((job) => job.state === "running").map((job) => this.#snapshot(job));
	}

	/** Recheck unclaimed exits when the parent agent finishes its turn. */
	flushCompletions(): void {
		if (this.#announcementTimer) clearTimeout(this.#announcementTimer);
		this.#announcementTimer = undefined;
		if (this.#closing || !this.canAnnounce()) return;
		const completed = [...this.#jobs.values()].filter(
			(job) => job.finishedWriting && !job.claimed && job.waiters === 0,
		);
		if (!completed.length) return;
		for (const job of completed) job.claimed = true;
		try {
			this.sink(completed.map((job) => this.#snapshot(job)));
		} catch {
			// A notification failure must not crash Pi.
		}
	}

	#scheduleAnnouncement(): void {
		if (this.#closing || this.#announcementTimer) return;
		this.#announcementTimer = setTimeout(() => this.flushCompletions(), ANNOUNCE_DELAY_MS);
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
			return this.#snapshot(job);
		}
		if (name === "status") return [...this.#jobs.values()].map((job) => this.#snapshot(job));
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
			if (job.state === "running") {
				job.waiters++;
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						job.finished,
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, bounded(args.waitMs, 30_000, 120_000));
						}),
					]);
				} finally {
					job.waiters--;
					if (timer) clearTimeout(timer);
				}
			}
			if (job.endedAt) job.claimed = true;
			return this.#snapshot(job);
		}
		if (name === "logs") {
			const max = bounded(args.maxChars, 4_000, MAX_LOG_CHARS);
			// Read a bounded tail rather than loading an unbounded watcher log into memory.
			const file = await open(job.outputPath, "r").catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
			let text = "";
			let truncated = false;
			if (file) {
				try {
					const size = (await file.stat()).size;
					const offset = Math.max(0, size - max * 4);
					const buffer = Buffer.alloc(size - offset);
					const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
					const tail = buffer.subarray(0, bytesRead).toString("utf8");
					text = tail.slice(-max);
					truncated = Boolean(job.logTruncated) || offset > 0 || tail.length > max;
				} finally {
					await file.close();
				}
			}
			// Claim only the terminal result actually returned, not a running read or a failed read.
			if (job.endedAt) job.claimed = true;
			return { ...this.#snapshot(job), text, truncated };
		}
		throw new Error(`Unknown jobs action: ${name}`);
	}

	#get(id: unknown): Job {
		const job = typeof id === "string" ? this.#jobs.get(id) : undefined;
		if (!job) throw new Error(`Unknown job: ${String(id)}`);
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
