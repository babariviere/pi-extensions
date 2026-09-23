/** Session-owned shell jobs. No QuickJS promise or tool-call abort signal owns a job. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { terminateProcessTree } from "../agents/process-tree.ts";
import type {
	CodeModeActionDescriptor,
	CodeModeInvocationContext,
	CodeModeProvider,
	CodeModeProviderListRequest,
} from "../protocol.ts";

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
export type JobCompletionSink = (job: JobSnapshot) => void;

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

const descriptors: CodeModeActionDescriptor[] = [
	{
		name: "start",
		description:
			"Start a named shell command in the background. Not tied to the tool call. Runs until exit, stop, session shutdown, or the 2-hour cap. Output is stored in a temporary file.",
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
			"Wait for a job to exit, or return running after waitMs (default 30 seconds). A terminal wait claims its result and suppresses the completion wake-up.",
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
		description: "Read the last maxChars of a job's output (default 4000, max 20000).",
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

const bounded = (value: unknown, fallback: number, max: number): number =>
	typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : fallback;

export class CodeModeJobsProvider implements CodeModeProvider {
	readonly name = "jobs";
	readonly description = "Session-owned background shell jobs";
	readonly fullCodeOnly = true;
	readonly #jobs = new Map<string, Job>();
	#closing = false;
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
		for (const job of this.#jobs.values()) this.#announce(job);
	}

	#announce(job: Job): void {
		if (this.#closing || !job.finishedWriting || job.claimed || job.waiters > 0 || !this.canAnnounce()) return;
		job.claimed = true;
		try {
			this.sink(this.#snapshot(job));
		} catch {
			// A notification failure must not crash Pi.
		}
	}

	async list(
		_request: CodeModeProviderListRequest,
		_context: CodeModeInvocationContext,
	): Promise<CodeModeActionDescriptor[]> {
		return descriptors;
	}
	async describe(name: string, _context: CodeModeInvocationContext): Promise<CodeModeActionDescriptor | undefined> {
		return descriptors.find((item) => item.name === name);
	}

	async invoke(name: string, args: Record<string, unknown>, context: CodeModeInvocationContext): Promise<unknown> {
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
			const dir = await mkdtemp(join(tmpdir(), "pi-code-mode-job-"));
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
				const announcement = setTimeout(() => this.#announce(job), ANNOUNCE_DELAY_MS);
				announcement.unref?.();
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
			if (!file) return { ...this.#snapshot(job), text: "", truncated: false };
			try {
				const size = (await file.stat()).size;
				const offset = Math.max(0, size - max * 4);
				const buffer = Buffer.alloc(size - offset);
				const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
				const text = buffer.subarray(0, bytesRead).toString("utf8");
				return {
					...this.#snapshot(job),
					text: text.slice(-max),
					truncated: Boolean(job.logTruncated) || offset > 0 || text.length > max,
				};
			} finally {
				await file.close();
			}
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
