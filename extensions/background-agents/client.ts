import { lstat, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import type { BackgroundRequest, BackgroundResponse } from "./protocol.ts";
import { BACKGROUND_AGENTS_PROTOCOL_VERSION, encodeBackgroundMessage } from "./protocol.ts";
import type { BackgroundSource, CaseAction, Classification, DashboardSnapshot, RolloutMode } from "./types.ts";

export const DEFAULT_BACKGROUND_AGENTS_SOCKET = resolve(join(homedir(), ".pi", "agent", "background-agents.sock"));
export const BACKGROUND_AGENTS_WORKER_MARKER = "PI_BACKGROUND_AGENT_ATTEMPT";

export interface BackgroundClientOptions {
	path?: string;
	ownerUid?: number;
	maxRequestBytes?: number;
	timeoutMs?: number;
}

export class BackgroundClientError extends Error {
	readonly code: "unavailable" | "invalid-response" | "request-failed";

	constructor(message: string, code: BackgroundClientError["code"] = "unavailable") {
		super(message);
		this.name = "BackgroundClientError";
		this.code = code;
	}
}

function currentUid(): number | undefined {
	return process.getuid?.();
}

/** Node 18-safe client for the controller's owner-only Unix socket. */
export class BackgroundClient {
	private readonly path: string;
	private readonly configuredOwnerUid: number | undefined;
	private readonly maxRequestBytes: number;
	private readonly timeoutMs: number;

	constructor(options: BackgroundClientOptions = {}) {
		this.path = resolve(options.path ?? DEFAULT_BACKGROUND_AGENTS_SOCKET);
		this.configuredOwnerUid = options.ownerUid ?? currentUid();
		this.maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
		this.timeoutMs = options.timeoutMs ?? 2_000;
		if (!Number.isSafeInteger(this.maxRequestBytes) || this.maxRequestBytes < 1)
			throw new Error("maxRequestBytes must be a positive integer");
		if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("timeoutMs must be positive");
	}

	get socketPath(): string {
		return this.path;
	}

	async request<T = unknown>(request: BackgroundRequest): Promise<T> {
		if (request.version !== BACKGROUND_AGENTS_PROTOCOL_VERSION)
			throw new BackgroundClientError("unsupported background-agent protocol version", "request-failed");
		await this.assertOwnerOnlySocket();
		const line = encodeBackgroundMessage(request);
		if (Buffer.byteLength(line) > this.maxRequestBytes)
			throw new BackgroundClientError("background-agent request exceeds maximum size", "request-failed");

		return new Promise<T>((resolveRequest, reject) => {
			let settled = false;
			let responseBuffer = "";
			const socket = connect({ path: this.path });
			const finish = (error?: Error, value?: T) => {
				if (settled) return;
				settled = true;
				socket.destroy();
				if (error) reject(error);
				else resolveRequest(value as T);
			};
			const timer = setTimeout(
				() => finish(new BackgroundClientError(`background-agent controller timed out after ${this.timeoutMs}ms`)),
				this.timeoutMs,
			);
			const fail = (error: unknown) => {
				clearTimeout(timer);
				finish(
					error instanceof BackgroundClientError
						? error
						: new BackgroundClientError(error instanceof Error ? error.message : String(error)),
				);
			};
			socket.once("error", fail);
			socket.on("data", (chunk: Buffer) => {
				responseBuffer += chunk.toString("utf8");
				if (Buffer.byteLength(responseBuffer) > this.maxRequestBytes) {
					fail(new BackgroundClientError("background-agent response exceeds maximum size", "invalid-response"));
					return;
				}
				const newline = responseBuffer.indexOf("\n");
				if (newline < 0) return;
				const encoded = responseBuffer.slice(0, newline);
				let value: unknown;
				try {
					value = JSON.parse(encoded);
				} catch {
					fail(new BackgroundClientError("controller returned invalid JSON", "invalid-response"));
					return;
				}
				if (!value || typeof value !== "object" || (value as Record<string, unknown>).version !== 1)
					return fail(
						new BackgroundClientError("controller returned an unsupported response", "invalid-response"),
					);
				const response = value as BackgroundResponse;
				if (typeof response.ok !== "boolean")
					return fail(new BackgroundClientError("controller response status was invalid", "invalid-response"));
				if (response.id !== request.id)
					return fail(
						new BackgroundClientError("controller response id did not match request", "invalid-response"),
					);
				clearTimeout(timer);
				if (!response.ok) {
					if (!response.error || typeof response.error.message !== "string")
						return finish(new BackgroundClientError("controller returned an invalid error", "invalid-response"));
					return finish(new BackgroundClientError(response.error.message, "request-failed"));
				}
				finish(undefined, response.result as T);
			});
			socket.once("connect", () => socket.write(line));
		});
	}

	async getDashboard(): Promise<DashboardSnapshot> {
		return this.request<DashboardSnapshot>({
			version: BACKGROUND_AGENTS_PROTOCOL_VERSION,
			id: requestId(),
			type: "dashboard.get",
		});
	}

	async submit(title: string, body: string, repository?: string): Promise<unknown> {
		return this.request({
			version: BACKGROUND_AGENTS_PROTOCOL_VERSION,
			id: requestId(),
			type: "case.submit",
			source: "manual",
			title,
			body,
			...(repository ? { repository } : {}),
		});
	}

	async action(caseId: string, action: CaseAction, comment?: string): Promise<unknown> {
		return this.request({
			version: BACKGROUND_AGENTS_PROTOCOL_VERSION,
			id: requestId(),
			type: "case.action",
			caseId,
			action,
			...(comment ? { comment } : {}),
		});
	}

	async correctClassification(caseId: string, classification: Classification): Promise<unknown> {
		return this.request({
			version: BACKGROUND_AGENTS_PROTOCOL_VERSION,
			id: requestId(),
			type: "classifier.correct",
			caseId,
			classification,
		});
	}

	async reproduce(caseId: string, manifestId: string): Promise<unknown> {
		return this.request({
			version: BACKGROUND_AGENTS_PROTOCOL_VERSION,
			id: requestId(),
			type: "evidence.reproduce",
			caseId,
			manifestId,
		});
	}

	async setRollout(value: RolloutMode, source?: BackgroundSource, repository?: string): Promise<unknown> {
		if (repository)
			return this.request({
				version: BACKGROUND_AGENTS_PROTOCOL_VERSION,
				id: requestId(),
				type: "rollout.set",
				scope: "repository",
				value,
				repository,
			});
		if (source)
			return this.request({
				version: BACKGROUND_AGENTS_PROTOCOL_VERSION,
				id: requestId(),
				type: "rollout.set",
				scope: "source",
				value,
				source,
			});
		return this.request({
			version: BACKGROUND_AGENTS_PROTOCOL_VERSION,
			id: requestId(),
			type: "rollout.set",
			scope: "global",
			value,
		});
	}

	async setEmergencyStop(enabled: boolean): Promise<unknown> {
		return this.request({
			version: BACKGROUND_AGENTS_PROTOCOL_VERSION,
			id: requestId(),
			type: "emergency.stop",
			enabled,
		});
	}

	private async assertOwnerOnlySocket(): Promise<void> {
		const uid = currentUid();
		if (uid !== undefined && this.configuredOwnerUid !== undefined && uid !== this.configuredOwnerUid)
			throw new BackgroundClientError("configured background-agent owner is not the current operator");
		let stats: Awaited<ReturnType<typeof lstat>>;
		try {
			stats = await lstat(this.path);
		} catch {
			throw new BackgroundClientError(`background-agent controller is unavailable at ${this.path}`);
		}
		if (!stats.isSocket()) throw new BackgroundClientError("background-agent path is not a Unix socket");
		if (this.configuredOwnerUid !== undefined && stats.uid !== this.configuredOwnerUid)
			throw new BackgroundClientError("background-agent socket is not owned by the current operator");
		if ((stats.mode & 0o077) !== 0)
			throw new BackgroundClientError("background-agent socket is group/world accessible");
		const current = await stat(this.path).catch(() => undefined);
		if (!current?.isSocket()) throw new BackgroundClientError("background-agent socket changed unexpectedly");
	}
}

function requestId(): string {
	return `dashboard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function isBackgroundWorkerSession(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[BACKGROUND_AGENTS_WORKER_MARKER] === "1";
}

export function isInteractiveOperatorSession(mode: string, environment: NodeJS.ProcessEnv = process.env): boolean {
	return mode === "tui" && !isBackgroundWorkerSession(environment);
}
