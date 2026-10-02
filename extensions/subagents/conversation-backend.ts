/** Isolated persistent kernels. Only the worker Harness may generate or execute tools. */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { nightChildEnv } from "../night-mode/night-run.ts";
import { prepareConfigHome } from "../night-mode/sandbox-clone.ts";
import { SANDBOX_MODE_FLAG } from "./constants.ts";
import { runCwd, withChildConfigHome } from "./run.ts";
import { signalProcessTree } from "./process-tree.ts";
import type { WorkerAnswer, WorkerCommand, WorkerPacket, WorkerSpec, WorkerStatus } from "./worker-protocol.ts";

export interface WorkerCallbacks {
	answer(id: string, result: WorkerAnswer, status: WorkerStatus): void;
	exit(error?: Error): void;
}
export interface WorkerConnection {
	readonly ready: Promise<WorkerStatus>;
	input(id: string, message: string, followUp: boolean): Promise<WorkerStatus>;
	status(): Promise<WorkerStatus>;
	stop(id: string): Promise<WorkerStatus>;
	pause(): Promise<void>;
	cancel(): Promise<void>;
}
export type WorkerFactory = (spec: WorkerSpec, callbacks: WorkerCallbacks) => WorkerConnection;

export const openConversationWorker: WorkerFactory = (spec, callbacks) => {
	mkdirSync(spec.directory, { recursive: true, mode: 0o700 });
	const night = spec.request.night ? spec.context.nightRun : undefined;
	if (spec.request.night && !night)
		throw new Error("Approved night contract unavailable; refusing an unprotected worker");
	const nightSnapshot = night ? join(spec.directory, "night-contract.json") : undefined;
	if (nightSnapshot) writeFileSync(nightSnapshot, JSON.stringify(night), { mode: 0o600 });
	const configHome = night ? undefined : prepareConfigHome(join(spec.directory, "config-home")).path;
	const args = [fileURLToPath(new URL("./worker-bootstrap.mjs", import.meta.url))];
	if (spec.request.agent.config.sandbox) args.push(`--${SANDBOX_MODE_FLAG}`, spec.request.agent.config.sandbox);
	const child = spawn(process.execPath, args, {
		cwd: runCwd(spec.request, spec.context),
		detached: true,
		stdio: ["ignore", "ignore", "pipe", "ipc"],
		env: {
			...withChildConfigHome(configHome, night ? nightChildEnv(night) : process.env),
			...(nightSnapshot ? { PI_DURABLE_NIGHT_RUN_FILE: nightSnapshot } : {}),
			PI_CODE_MODE_SUBAGENT: "1",
			PI_SUBAGENT_HOST_PACKAGE_DIR: getPackageDir(),
		},
	});
	let stderr = "";
	let ended = false;
	let exitError: Error | undefined;
	let closing: Promise<void> | undefined;
	let acceptReady!: (status: WorkerStatus) => void;
	let rejectReady!: (error: Error) => void;
	const ready = new Promise<WorkerStatus>((resolve, reject) => {
		acceptReady = resolve;
		rejectReady = reject;
	});
	void ready.catch(() => {});
	const pending = new Map<
		string,
		{ resolve(status: WorkerStatus): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
	>();
	let acceptClosed!: () => void;
	const closed = new Promise<void>((resolve) => {
		acceptClosed = resolve;
	});
	const end = (error?: Error) => {
		if (ended) return;
		ended = true;
		if (child.exitCode === null && child.signalCode === null) signalProcessTree(child, "SIGKILL");
		clearTimeout(startTimer);
		const failure = error ?? new Error(stderr || "Subagent worker closed");
		exitError = failure;
		rejectReady(failure);
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(failure);
		}
		pending.clear();
	};
	const send = (packet: WorkerCommand) => {
		if (ended || !child.connected) throw new Error("Subagent worker is disconnected");
		child.send(packet, (error) => {
			if (error) end(error);
		});
	};
	const startTimer = setTimeout(() => {
		signalProcessTree(child, "SIGKILL");
		end(new Error(stderr || "Subagent worker startup timed out"));
	}, 20_000);
	startTimer.unref();
	child.stderr?.on("data", (chunk) => {
		stderr = (stderr + String(chunk)).slice(-16_384);
	});
	child.once("error", (error) => end(error));
	child.once("close", () => {
		end();
		acceptClosed();
		try {
			callbacks.exit(closing ? undefined : exitError);
		} catch {
			/* Cleanup cannot depend on observers. */
		}
	});
	child.on("message", (message: unknown) => {
		if (!message || typeof message !== "object") return;
		const packet = message as WorkerPacket;
		if (packet.type === "ready") {
			clearTimeout(startTimer);
			acceptReady(packet.status);
		} else if (packet.type === "answer") {
			try {
				callbacks.answer(packet.id, packet.result, packet.status);
			} catch {
				/* Observer failure cannot orphan the kernel. */
			}
		} else if (packet.type === "error") {
			const failure = new Error(packet.error);
			const request = packet.id ? pending.get(packet.id) : undefined;
			if (request) {
				clearTimeout(request.timer);
				pending.delete(packet.id!);
				request.reject(failure);
			} else end(failure);
		} else if (packet.type !== "paused") {
			const request = pending.get(packet.id);
			if (request) {
				clearTimeout(request.timer);
				pending.delete(packet.id);
				request.resolve(packet.status);
			}
		}
	});
	const request = async (packet: Extract<WorkerCommand, { id: string }>, timeout = 20_000): Promise<WorkerStatus> => {
		await ready;
		if (pending.has(packet.id)) throw new Error("Duplicate in-flight worker request ID");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(packet.id);
				signalProcessTree(child, "SIGKILL");
				const error = new Error(`Subagent ${packet.type} acknowledgment timed out`);
				reject(error);
				end(error);
			}, timeout);
			pending.set(packet.id, { resolve, reject, timer });
			try {
				send(packet);
			} catch (error) {
				clearTimeout(timer);
				pending.delete(packet.id);
				reject(error);
			}
		});
	};
	const close = (type: "pause" | "cancel") =>
		(closing ??= (async () => {
			if (ended) return closed;
			let terminate: ReturnType<typeof setTimeout> | undefined;
			let kill: ReturnType<typeof setTimeout> | undefined;
			try {
				try {
					send({ type });
				} catch {
					signalProcessTree(child, "SIGKILL");
				}
				terminate = setTimeout(() => signalProcessTree(child, "SIGTERM"), 2_000);
				kill = setTimeout(() => {
					signalProcessTree(child, "SIGKILL");
					end();
				}, 4_000);
				await closed;
			} finally {
				if (terminate) clearTimeout(terminate);
				if (kill) clearTimeout(kill);
			}
		})());
	try {
		send({ type: "start", spec });
	} catch (error) {
		end(error instanceof Error ? error : new Error(String(error)));
	}
	return {
		ready,
		input: (id, message, followUp) => request({ type: "input", id, message, followUp }),
		status: () => request({ type: "status", id: randomUUID() }),
		stop: (id) => request({ type: "stop", id }, 5_000),
		pause: () => close("pause"),
		cancel: () => close("cancel"),
	};
};
