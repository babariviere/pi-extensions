import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type ClefConfig, MODEL_SPECS } from "./config.ts";
import { ClefSetup } from "./setup.ts";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_QUEUE = 16;

interface Pending {
	id: number;
	line: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
	signal?: AbortSignal;
	abort: () => void;
	timeout: number;
}

export interface WorkerRequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** Startup and inference check readiness; only explicit installation can fetch dependencies. */
export class ClefWorker {
	private child?: ChildProcessWithoutNullStreams;
	private queue: Pending[] = [];
	private active?: Pending;
	private idleTimer?: NodeJS.Timeout;
	private retiring?: Promise<void>;
	private pumping = false;
	private disposed = false;
	private nextId = 0;
	private buffer = "";

	constructor(
		private config: ClefConfig,
		private command?: { executable: string; args: string[] },
		private setup: Pick<ClefSetup, "prepare" | "unload" | "status"> | undefined = command
			? undefined
			: new ClefSetup(config),
	) {}

	async prepare(install = false): Promise<void> {
		if (this.disposed) throw new Error("Clef worker is stopped");
		const ready = await this.setup?.prepare(install);
		if (ready && !this.command) {
			this.command = {
				executable: ready.python,
				args: [
					"-u",
					fileURLToPath(new URL("./worker.py", import.meta.url)),
					"--model",
					ready.modelPath,
					"--revision",
					MODEL_SPECS[this.config.model].revision,
					"--max-length",
					String(this.config.maxLength),
					"--memory-limit-gb",
					String(this.config.memoryLimitGB),
				],
			};
		}
	}

	get status(): string {
		if (this.disposed) return "stopped";
		if (this.setup && this.setup.status !== "prepared" && this.setup.status !== "not prepared")
			return this.setup.status;
		if (this.active) return `busy (${this.queue.length} queued)`;
		if (this.retiring) return "unloading";
		return this.child ? "ready" : "unloaded";
	}

	request(payload: unknown, options: WorkerRequestOptions = {}): Promise<unknown> {
		if (this.disposed) return Promise.reject(new Error("Clef worker is stopped"));
		if (options.signal?.aborted) return Promise.reject(new Error("Clef classification aborted"));
		if (this.queue.length >= MAX_QUEUE) return Promise.reject(new Error("Clef queue is full (16 waiting calls)"));
		const timeout = options.timeoutMs ?? this.config.requestTimeoutMs;
		if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600_000)
			return Promise.reject(new Error("Clef timeoutMs must be an integer from 1 to 3600000"));
		let line: string;
		const id = ++this.nextId;
		try {
			line = JSON.stringify({ id, payload });
			if (Buffer.byteLength(line) > MAX_BYTES) throw new Error("Clef request exceeds 4 MiB");
		} catch (error) {
			return Promise.reject(error);
		}
		return new Promise((resolve, reject) => {
			const pending: Pending = {
				id,
				line,
				resolve,
				reject,
				signal: options.signal,
				abort: () => this.cancel(pending, new Error("Clef classification aborted")),
				timeout,
			};
			if (!this.setup || this.setup.status === "prepared") this.startDeadline(pending);
			pending.signal?.addEventListener("abort", pending.abort, { once: true });
			this.queue.push(pending);
			void this.pump();
		});
	}

	private startDeadline(pending: Pending): void {
		pending.timer ??= setTimeout(
			() => this.cancel(pending, new Error(`Clef timed out after ${pending.timeout} ms`)),
			pending.timeout,
		);
	}

	private cancel(pending: Pending, error: Error): void {
		if (this.active === pending) this.retire();
		this.finish(pending, undefined, error);
	}

	private finish(pending: Pending, value?: unknown, error?: Error): void {
		if (this.active !== pending && !this.queue.includes(pending)) return;
		clearTimeout(pending.timer);
		pending.signal?.removeEventListener("abort", pending.abort);
		if (this.active === pending) this.active = undefined;
		else this.queue = this.queue.filter((entry) => entry !== pending);
		if (error) pending.reject(error);
		else pending.resolve(value);
		void this.pump();
	}

	private async pump(): Promise<void> {
		if (this.pumping || this.active || this.disposed) return;
		this.pumping = true;
		clearTimeout(this.idleTimer);
		try {
			await this.retiring;
			if (this.disposed) return;
			if (this.queue.length) {
				await this.prepare();
				if (this.disposed) return;
				for (const pending of this.queue) this.startDeadline(pending);
			}
			const pending = this.queue.shift();
			if (!pending) {
				if (this.child) {
					this.idleTimer = setTimeout(() => this.retire(), this.config.idleTimeoutMs);
					this.idleTimer.unref();
				}
				return;
			}
			this.active = pending;
			const child = this.child ?? this.start();
			child.stdin.write(`${pending.line}\n`, (error) => {
				if (error && this.active === pending) this.failTransport(new Error("Clef worker input closed"));
			});
		} catch (error) {
			const failure = error instanceof Error ? error : new Error("Cannot start Clef worker");
			this.failTransport(failure);
			for (const pending of [...this.queue]) this.finish(pending, undefined, failure);
		} finally {
			this.pumping = false;
			if (!this.active && this.queue.length) void this.pump();
		}
	}

	private start(): ChildProcessWithoutNullStreams {
		if (!this.command) throw new Error("Clef setup has not completed");
		const child = spawn(this.command.executable, this.command.args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				HF_HUB_OFFLINE: "1",
				TRANSFORMERS_OFFLINE: "1",
				HF_HUB_DISABLE_TELEMETRY: "1",
				PYTHONDONTWRITEBYTECODE: "1",
			},
		});
		this.child = child;
		this.buffer = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (this.child !== child) return;
			this.buffer += chunk;
			if (Buffer.byteLength(this.buffer) > MAX_BYTES) {
				this.failTransport(new Error("Clef worker response exceeds 4 MiB"));
				return;
			}
			let end: number;
			while ((end = this.buffer.indexOf("\n")) >= 0 && this.child === child) {
				const line = this.buffer.slice(0, end);
				this.buffer = this.buffer.slice(end + 1);
				try {
					const reply = JSON.parse(line);
					const pending = this.active;
					if (!pending || reply?.id !== pending.id || typeof reply.ok !== "boolean")
						throw new Error("Invalid worker response");
					if (reply.ok) this.finish(pending, reply.result);
					else {
						if (typeof reply.error !== "string") throw new Error("Invalid worker error");
						if (reply.fatal === true) this.retire();
						this.finish(pending, undefined, new Error(reply.error.slice(0, 2000)));
					}
				} catch {
					this.failTransport(new Error("Clef worker returned an invalid JSON-lines response"));
				}
			}
		});
		// Drain library diagnostics without retaining or exposing request data.
		child.stderr.resume();
		child.stdin.on("error", () => {
			if (this.child === child) this.failTransport(new Error("Clef worker input closed"));
		});
		child.on("error", () => {
			if (this.child === child)
				this.failTransport(
					new Error("Cannot start Clef Python worker. Check python in clef.json and the setup README."),
				);
		});
		child.on("close", (code, signal) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.buffer = "";
			if (this.active)
				this.finish(
					this.active,
					undefined,
					new Error(`Clef worker exited (${signal ?? code}). Check available memory and setup.`),
				);
		});
		return child;
	}

	private failTransport(error: Error): void {
		this.retire();
		if (this.active) this.finish(this.active, undefined, error);
	}

	/** Wait for actual process exit before permitting another cold start. */
	private retire(): void {
		clearTimeout(this.idleTimer);
		const child = this.child;
		if (!child) return;
		this.child = undefined;
		this.buffer = "";
		const closing = new Promise<void>((resolve) => {
			const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
			child.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
			child.kill("SIGTERM");
		});
		this.retiring = closing;
		void closing.then(() => {
			if (this.retiring === closing) this.retiring = undefined;
		});
	}

	async unload(): Promise<void> {
		this.retire();
		for (const pending of [...(this.active ? [this.active] : []), ...this.queue])
			this.finish(pending, undefined, new Error("Clef worker unloaded"));
		await this.setup?.unload();
		await this.retiring;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.unload();
	}
}
