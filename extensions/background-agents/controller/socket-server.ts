import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import {
	BACKGROUND_AGENTS_PROTOCOL_VERSION,
	encodeBackgroundMessage,
	isBackgroundRequest,
	validateBackgroundRequest,
	type BackgroundRequest,
	type BackgroundResponse,
} from "../protocol.ts";
import type { SocketContract } from "../types.ts";

export interface BackgroundSocketServerOptions extends SocketContract {
	handle(request: BackgroundRequest): Promise<BackgroundResponse> | BackgroundResponse;
}

function response(id: string, message: string, code = "INVALID_REQUEST"): BackgroundResponse {
	return { version: BACKGROUND_AGENTS_PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}

function requestId(value: unknown): string {
	return value && typeof value === "object" && typeof (value as Record<string, unknown>).id === "string"
		? String((value as Record<string, unknown>).id)
		: "";
}

function prepareSocket(path: string, ownerUid: number | undefined): void {
	if (!existsSync(path)) return;
	const stats = lstatSync(path);
	if (!stats.isSocket()) throw new Error(`socket path is not a Unix socket: ${path}`);
	const expectedUid = ownerUid ?? process.getuid?.();
	if (expectedUid !== undefined && stats.uid !== expectedUid)
		throw new Error(`socket is not owned by configured owner uid ${expectedUid}`);
	unlinkSync(path);
}

/** Newline-delimited, versioned API server. The Unix socket's owner and mode are fail-closed. */
export class BackgroundSocketServer {
	private readonly server: Server;
	private readonly clients = new Set<Socket>();
	private listening = false;

	constructor(private readonly options: BackgroundSocketServerOptions) {
		if (!options.path.trim()) throw new Error("socket path must be non-empty");
		if (!Number.isSafeInteger(options.maxRequestBytes) || options.maxRequestBytes < 1)
			throw new Error("maxRequestBytes must be a positive integer");
		if (options.mode < 0o600 || (options.mode & 0o077) !== 0) throw new Error("socket mode is unsafe");
		const expectedUid = options.ownerUid ?? process.getuid?.();
		if (expectedUid !== undefined && process.getuid && process.getuid() !== expectedUid)
			throw new Error(`controller is not running as configured socket owner uid ${expectedUid}`);
		this.server = createServer((socket) => this.connection(socket));
	}

	start(): Promise<void> {
		if (this.listening) return Promise.resolve();
		prepareSocket(this.options.path, this.options.ownerUid);
		mkdirSync(dirname(this.options.path), { recursive: true });
		return new Promise((resolve, reject) => {
			const onError = (error: Error) => {
				this.server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				this.server.off("error", onError);
				try {
					chmodSync(this.options.path, this.options.mode);
					const stats = statSync(this.options.path);
					const expectedUid = this.options.ownerUid ?? process.getuid?.();
					if (expectedUid !== undefined && stats.uid !== expectedUid)
						throw new Error("socket owner changed unexpectedly");
					this.listening = true;
					resolve();
				} catch (error) {
					this.server.close();
					reject(error);
				}
			};
			this.server.once("error", onError);
			this.server.once("listening", onListening);
			this.server.listen(this.options.path);
		});
	}

	stop(): Promise<void> {
		for (const client of this.clients) client.destroy();
		if (!this.listening) {
			if (existsSync(this.options.path)) unlinkSync(this.options.path);
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.server.close(() => {
				this.listening = false;
				if (existsSync(this.options.path)) unlinkSync(this.options.path);
				resolve();
			});
		});
	}

	private connection(socket: Socket): void {
		this.clients.add(socket);
		let buffer = Buffer.alloc(0);
		const rejectLine = (message: string, id = "") => socket.write(encodeBackgroundMessage(response(id, message)));
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > this.options.maxRequestBytes && !buffer.includes(10)) {
				rejectLine("request exceeds maximum size", "");
				socket.destroy();
				return;
			}
			while (true) {
				const newline = buffer.indexOf(10);
				if (newline < 0) break;
				const line = buffer.subarray(0, newline);
				buffer = buffer.subarray(newline + 1);
				if (line.length > this.options.maxRequestBytes) {
					rejectLine("request exceeds maximum size");
					continue;
				}
				void this.dispatch(line, socket, rejectLine);
			}
			if (buffer.length > this.options.maxRequestBytes) {
				rejectLine("request exceeds maximum size");
				socket.destroy();
			}
		});
		socket.on("close", () => this.clients.delete(socket));
		socket.on("error", () => this.clients.delete(socket));
	}

	private async dispatch(
		line: Buffer,
		socket: Socket,
		rejectLine: (message: string, id?: string) => void,
	): Promise<void> {
		let value: unknown;
		try {
			value = JSON.parse(line.toString("utf8"));
		} catch {
			rejectLine("request is not valid JSON");
			return;
		}
		const error = validateBackgroundRequest(value);
		if (error || !isBackgroundRequest(value)) {
			rejectLine(error ?? "request is invalid", requestId(value));
			return;
		}
		try {
			const result = await this.options.handle(value);
			if (!socket.destroyed) socket.write(encodeBackgroundMessage(result));
		} catch (error) {
			if (!socket.destroyed)
				socket.write(
					encodeBackgroundMessage(
						response(requestId(value), error instanceof Error ? error.message : String(error), "HANDLER_ERROR"),
					),
				);
		}
	}
}

export function createBackgroundSocketServer(options: BackgroundSocketServerOptions): BackgroundSocketServer {
	return new BackgroundSocketServer(options);
}
