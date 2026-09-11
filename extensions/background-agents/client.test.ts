import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BackgroundClient } from "./client.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("uses the versioned owner-only socket and returns dashboard data", async () => {
	const root = mkdtempSync(join(tmpdir(), "background-client-"));
	roots.push(root);
	const path = join(root, "controller.sock");
	const server = createServer((socket) => {
		socket.on("data", (data) => {
			const request = JSON.parse(data.toString()) as { id: string };
			socket.write(JSON.stringify({ version: 1, id: request.id, ok: true, result: { cases: [] } }) + "\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	chmodSync(path, 0o600);
	const client = new BackgroundClient({ path, ownerUid: process.getuid?.(), timeoutMs: 500 });
	assert.deepEqual(await client.getDashboard(), { cases: [] });
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("rejects a group-accessible socket before connecting", async () => {
	const root = mkdtempSync(join(tmpdir(), "background-client-mode-"));
	roots.push(root);
	const path = join(root, "controller.sock");
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(path, resolve));
	chmodSync(path, 0o660);
	await assert.rejects(new BackgroundClient({ path }).getDashboard(), /group\/world accessible/);
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
