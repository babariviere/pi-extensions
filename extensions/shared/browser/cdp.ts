/**
 * Minimal Chrome DevTools Protocol client over one WebSocket.
 *
 * Supports flattened target sessions (`Target.attachToTarget({ flatten: true })`),
 * so one browser-level connection can drive many pages.
 */

import WebSocket from "ws";

export class CdpError extends Error {
	override name = "CdpError";
}

export interface CdpCallOptions {
	/** Reject the call when no reply arrives within this many milliseconds. */
	timeoutMs?: number;
}

/** Commands and events scoped to one flattened target session. */
export interface CdpSession {
	// biome-ignore lint/suspicious/noExplicitAny: CDP results are untyped
	call(method: string, params?: Record<string, unknown>, options?: CdpCallOptions): Promise<any>;
	/** Subscribe to an event; returns an unsubscribe function. */
	// biome-ignore lint/suspicious/noExplicitAny: CDP event payloads are untyped
	on(method: string, handler: (params: any) => void): () => void;
}

export interface CdpOptions {
	/** Aborting closes the connection and rejects every pending call. */
	signal?: AbortSignal;
	/** Default per-call timeout. Unset means calls wait until the socket closes. */
	callTimeoutMs?: number;
	/** Called once when the socket closes for any reason. */
	onClose?: () => void;
}

interface Pending {
	// biome-ignore lint/suspicious/noExplicitAny: CDP results are untyped
	resolve: (value: any) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

// biome-ignore lint/suspicious/noExplicitAny: CDP event payloads are untyped
type Handler = (params: any) => void;

export class Cdp {
	private ws?: WebSocket;
	private nextId = 1;
	private closed = false;
	private readonly pending = new Map<number, Pending>();
	private readonly handlers = new Map<string, Set<Handler>>();
	private readonly onAbort = () => this.fail(new CdpError("Browser operation aborted"));

	constructor(
		private readonly url: string,
		private readonly options: CdpOptions = {},
	) {}

	get isOpen(): boolean {
		return !this.closed && this.ws?.readyState === WebSocket.OPEN;
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.options.signal?.aborted) return reject(new CdpError("Browser operation aborted"));
			const ws = new WebSocket(this.url, { perMessageDeflate: false });
			this.ws = ws;
			let opened = false;
			ws.on("open", () => {
				opened = true;
				this.options.signal?.addEventListener("abort", this.onAbort, { once: true });
				resolve();
			});
			ws.on("error", (err) => {
				if (!opened) reject(new CdpError(`CDP socket error: ${err.message}`));
				this.fail(new CdpError(`CDP socket error: ${err.message}`));
			});
			ws.on("close", () => this.fail(new CdpError("CDP connection closed")));
			ws.on("message", (data) => this.dispatch(data.toString()));
		});
	}

	private dispatch(raw: string): void {
		// biome-ignore lint/suspicious/noExplicitAny: CDP messages are untyped
		let msg: any;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof msg.id === "number") {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			if (p.timer) clearTimeout(p.timer);
			if (msg.error) p.reject(new CdpError(msg.error.message ?? "CDP error"));
			else p.resolve(msg.result);
			return;
		}
		if (typeof msg.method !== "string") return;
		for (const handler of this.handlers.get(key(msg.method, msg.sessionId)) ?? []) {
			try {
				handler(msg.params);
			} catch {
				// A failing listener must not break the connection.
			}
		}
	}

	/** Subscribe to an event, optionally for one session; returns an unsubscribe function. */
	on(method: string, handler: Handler, sessionId?: string): () => void {
		const k = key(method, sessionId);
		let set = this.handlers.get(k);
		if (!set) {
			set = new Set();
			this.handlers.set(k, set);
		}
		set.add(handler);
		return () => set.delete(handler);
	}

	// biome-ignore lint/suspicious/noExplicitAny: CDP results are untyped
	call(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
		options: CdpCallOptions = {},
	): Promise<any> {
		if (this.options.signal?.aborted) return Promise.reject(new CdpError("Browser operation aborted"));
		if (!this.isOpen) return Promise.reject(new CdpError("CDP connection closed"));
		const id = this.nextId++;
		const timeoutMs = options.timeoutMs ?? this.options.callTimeoutMs;
		return new Promise((resolve, reject) => {
			const pending: Pending = { resolve, reject };
			if (timeoutMs !== undefined) {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new CdpError(`CDP call ${method} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}
			this.pending.set(id, pending);
			this.ws!.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
		});
	}

	/** View of this connection scoped to a flattened target session. */
	session(sessionId: string): CdpSession {
		return {
			call: (method, params, options) => this.call(method, params, sessionId, options),
			on: (method, handler) => this.on(method, handler, sessionId),
		};
	}

	private fail(err: Error): void {
		for (const p of this.pending.values()) {
			if (p.timer) clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
		this.close();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.options.signal?.removeEventListener("abort", this.onAbort);
		try {
			this.ws?.close();
		} catch {
			// already closed
		}
		this.options.onClose?.();
	}
}

function key(method: string, sessionId?: string): string {
	return `${sessionId ?? ""}|${method}`;
}
