import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { Cdp } from "./cdp.ts";

test("a stalled WebSocket handshake has a bounded timeout", async (t) => {
	const server = createServer();
	server.on("upgrade", (_request, socket) => t.after(() => socket.destroy()));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const port = (server.address() as AddressInfo).port;
	const cdp = new Cdp(`ws://127.0.0.1:${port}`, { connectTimeoutMs: 50 });
	t.after(() => cdp.close(true));
	await assert.rejects(cdp.connect(), /timed out/);
});

test("an unresponsive browser close times out and the cleanup socket can be terminated", async (t) => {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	t.after(() => server.close());
	await new Promise<void>((resolve) => server.on("listening", resolve));
	const peerClosed = new Promise<void>((resolve) => {
		server.on("connection", (socket) => socket.on("close", resolve));
	});
	const cdp = new Cdp(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, { callTimeoutMs: 50 });
	t.after(() => cdp.close(true));
	await cdp.connect();
	await assert.rejects(cdp.call("Browser.close"), /timed out/);
	cdp.close(true);
	await peerClosed;
	assert.equal(cdp.isOpen, false);
});
