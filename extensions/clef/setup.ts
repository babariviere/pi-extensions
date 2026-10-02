import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ClefConfig, MODEL_SPECS } from "./config.ts";

export interface PreparedClef {
	python: string;
	modelPath: string;
}

/** Preparation never sees classification input or loads model weights. */
export class ClefSetup {
	private ready?: PreparedClef;
	private pending?: Promise<PreparedClef>;
	private child?: ChildProcessWithoutNullStreams;
	private stop?: () => void;
	private error?: Error;

	constructor(
		config: ClefConfig,
		private command = {
			executable: config.python,
			args: [
				"-B",
				fileURLToPath(new URL("./setup.py", import.meta.url)),
				"--model",
				config.modelPath ?? MODEL_SPECS[config.model].repo,
				"--revision",
				MODEL_SPECS[config.model].revision,
				"--venv",
				join(homedir(), ".local/share/pi-clef/venv"),
			],
		},
		private timeoutMs = 3_600_000,
	) {}

	get status(): string {
		if (this.pending) return "preparing Python environment and checkpoint";
		if (this.error) return `setup failed: ${this.error.message}`;
		return this.ready ? "prepared" : "not prepared";
	}

	prepare(): Promise<PreparedClef> {
		if (this.ready) return Promise.resolve(this.ready);
		if (this.pending) return this.pending;
		this.error = undefined;
		const env: NodeJS.ProcessEnv = { ...process.env, HF_HUB_DISABLE_TELEMETRY: "1", PYTHONDONTWRITEBYTECODE: "1" };
		delete env.HF_HUB_OFFLINE;
		delete env.TRANSFORMERS_OFFLINE;
		const grouped = process.platform !== "win32";
		const child = spawn(this.command.executable, this.command.args, {
			stdio: ["pipe", "pipe", "pipe"],
			env,
			detached: grouped,
		});
		this.child = child;
		const running = new Promise<PreparedClef>((resolve, reject) => {
			let output = "";
			let failure: Error | undefined;
			let killTimer: NodeJS.Timeout | undefined;
			const kill = (signal: NodeJS.Signals) => {
				try {
					if (grouped && child.pid) process.kill(-child.pid, signal);
					else child.kill(signal);
				} catch {
					// The process may already have exited.
				}
			};
			const stop = (error: Error) => {
				if (failure) return;
				failure = error;
				kill("SIGTERM");
				killTimer = setTimeout(() => kill("SIGKILL"), 1000);
			};
			this.stop = () => stop(new Error("Clef setup cancelled"));
			const timer = setTimeout(
				() => stop(new Error("Clef setup timed out after one hour. Retry /clef setup.")),
				this.timeoutMs,
			);
			child.stdin.end();
			child.stdin.on("error", () => {});
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				output += chunk;
				if (Buffer.byteLength(output) > 16_384) {
					output = "";
					stop(new Error("Clef setup returned an oversized response"));
				}
			});
			// Bootstrap diagnostics must not become unbounded logs or classifier output.
			child.stderr.resume();
			child.on("error", () => {
				failure = new Error("Cannot start Clef setup. Install Python 3.11+ or check python in clef.json.");
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				clearTimeout(killTimer);
				this.child = undefined;
				this.stop = undefined;
				if (failure) return reject(failure);
				try {
					const result = JSON.parse(output);
					if (code !== 0) {
						throw new Error(
							typeof result?.error === "string"
								? result.error.slice(0, 2000)
								: "Clef setup failed. Check network access and free disk space, then retry /clef setup.",
						);
					}
					if (
						typeof result?.python !== "string" ||
						!isAbsolute(result.python) ||
						typeof result?.modelPath !== "string" ||
						!isAbsolute(result.modelPath)
					)
						throw new Error("Clef setup returned an invalid response");
					resolve({ python: result.python, modelPath: result.modelPath });
				} catch (error) {
					reject(error instanceof SyntaxError ? new Error("Clef setup returned an invalid response") : error);
				}
			});
		});
		this.pending = running.then(
			(result) => {
				this.ready = result;
				this.pending = undefined;
				return result;
			},
			(error: Error) => {
				this.error = error;
				this.pending = undefined;
				throw error;
			},
		);
		return this.pending;
	}

	async unload(): Promise<void> {
		if (!this.child) return;
		this.stop?.();
		await this.pending?.catch(() => {});
		if (this.error?.message === "Clef setup cancelled") this.error = undefined;
	}
}
