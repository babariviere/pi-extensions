import WebSocket from "ws";
import type { SourceEventResult } from "../database.ts";
import { type SourceAdapter, type SourceAdapterOptions, fingerprint, persistSourceEvent } from "./source.ts";

export interface SlackEnvelope {
	envelope_id?: string;
	type?: string;
	payload?: {
		event?: SlackEvent;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export interface SlackEvent {
	type?: string;
	event_id?: string;
	event_ts?: string;
	ts?: string;
	text?: string;
	channel?: string;
	user?: string;
	team?: string;
	thread_ts?: string;
	[key: string]: unknown;
}

export interface SlackSourceOptions extends SourceAdapterOptions {
	connectionUrl?: string;
	getConnectionUrl?: () => Promise<string>;
	reconnectMs?: number;
	socketFactory?: (url: string) => WebSocket;
}

function textFromEvent(event: SlackEvent): string {
	if (typeof event.text === "string") return event.text;
	return JSON.stringify(event);
}

function parseEnvelope(raw: WebSocket.RawData | string): SlackEnvelope {
	let value: unknown;
	try {
		value = JSON.parse(typeof raw === "string" ? raw : raw.toString());
	} catch (error) {
		throw new Error("Slack message was not valid JSON", { cause: error });
	}
	if (!value || typeof value !== "object") throw new Error("Slack message must be an object");
	return value as SlackEnvelope;
}

export class SlackSourceAdapter implements SourceAdapter {
	readonly source = "slack" as const;
	private readonly options: SlackSourceOptions;
	private socket?: WebSocket;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private connecting = false;
	private stopped = true;

	constructor(options: SlackSourceOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		this.stopped = false;
		await this.connect();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		const socket = this.socket;
		this.socket = undefined;
		if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close();
	}

	/** Process one envelope. The acknowledgement is sent only after durable persistence. */
	async handleEnvelope(raw: WebSocket.RawData | string, socket = this.socket): Promise<SourceEventResult | undefined> {
		const envelope = parseEnvelope(raw);
		const envelopeId = typeof envelope.envelope_id === "string" ? envelope.envelope_id : undefined;
		const event = envelope.payload?.event;
		if (!event || envelope.type !== "events_api") {
			if (envelopeId) this.ack(socket, envelopeId);
			return undefined;
		}
		const eventId = typeof event.event_id === "string" ? event.event_id : undefined;
		const eventKey = eventId ?? envelopeId;
		if (!eventKey) throw new Error("Slack event has neither event_id nor envelope_id");
		const result = persistSourceEvent(this.options, {
			source: "slack",
			sourceKey: `slack:${eventKey}`,
			revision: event.event_ts ?? event.ts ?? "",
			receivedAt: this.options.now?.() ?? new Date(),
			title: `Slack ${event.type ?? "event"}`,
			body: textFromEvent(event),
			fingerprint: fingerprint({ eventId, event }),
			service: typeof event.channel === "string" ? event.channel : undefined,
			metadata: { envelopeId, event },
		});
		if (envelopeId) this.ack(socket, envelopeId);
		return result;
	}

	private ack(socket: WebSocket | undefined, envelopeId: string): void {
		if (!socket || socket.readyState !== WebSocket.OPEN) return;
		socket.send(JSON.stringify({ envelope_id: envelopeId }));
	}

	private async connect(): Promise<void> {
		if (this.stopped || this.connecting || this.socket) return;
		this.connecting = true;
		try {
			const url = this.options.getConnectionUrl ? await this.options.getConnectionUrl() : this.options.connectionUrl;
			if (this.stopped) {
				this.connecting = false;
				return;
			}
			if (!url) throw new Error("Slack Socket Mode requires a connection URL provider");
			const socket = (this.options.socketFactory ?? ((value: string) => new WebSocket(value)))(url);
			this.socket = socket;
			socket.on("open", () => {
				this.connecting = false;
			});
			socket.on("message", (data) => {
				void this.handleEnvelope(data, socket).catch(() => {
					// Do not acknowledge failed persistence. Slack will redeliver the envelope.
				});
			});
			socket.on("error", () => {
				if (this.socket === socket && socket.readyState !== WebSocket.CLOSED) socket.close();
			});
			socket.on("close", () => {
				if (this.socket === socket) this.socket = undefined;
				this.connecting = false;
				this.scheduleReconnect();
			});
		} catch (error) {
			this.connecting = false;
			this.socket = undefined;
			this.scheduleReconnect();
			throw error;
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect().catch(() => {
				// A failed attempt schedules the next one.
			});
		}, this.options.reconnectMs ?? 5_000);
	}
}
