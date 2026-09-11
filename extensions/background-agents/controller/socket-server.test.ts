import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";
import { BackgroundSocketServer } from "./socket-server.ts";

const roots: string[] = [];
function waitForData(socket: ReturnType<typeof connect>): Promise<string> {
	return new Promise((resolve) => socket.once("data", (data) => resolve(data.toString())));
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("serves versioned requests and rejects invalid protocol messages", async () => {
	const root = mkdtempSync(join(tmpdir(), "background-socket-"));
	roots.push(root);
	const path = join(root, "controller.sock");
	const server = new BackgroundSocketServer({
		path,
		mode: 0o600,
		maxRequestBytes: 4096,
		handle: async (request) => ({ version: 1, id: request.id, ok: true, result: { type: request.type } }),
	});
	await server.start();
	const socket = connect(path);
	socket.write(JSON.stringify({ version: 1, id: "one", type: "dashboard.get" }) + "\n");
	assert.deepEqual(JSON.parse(await waitForData(socket)), {
		version: 1,
		id: "one",
		ok: true,
		result: { type: "dashboard.get" },
	});
	socket.write(JSON.stringify({ version: 99, id: "two", type: "dashboard.get" }) + "\n");
	assert.equal((JSON.parse(await waitForData(socket)) as { ok: boolean }).ok, false);
	socket.destroy();
	await server.stop();
});

test("enforces request size and removes the socket during shutdown", async () => {
	const root = mkdtempSync(join(tmpdir(), "background-socket-size-"));
	roots.push(root);
	const path = join(root, "controller.sock");
	const server = new BackgroundSocketServer({
		path,
		mode: 0o600,
		maxRequestBytes: 64,
		handle: () => ({ version: 1, id: "x", ok: true, result: {} }),
	});
	await server.start();
	const socket = connect(path);
	socket.write(`${"x".repeat(80)}\n`);
	assert.equal((JSON.parse(await waitForData(socket)) as { ok: boolean }).ok, false);
	socket.destroy();
	await server.stop();
	assert.equal(await import("node:fs").then(({ existsSync }) => existsSync(path)), false);
});
