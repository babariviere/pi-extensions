import assert from "node:assert/strict";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openConversationWorker, WORKER_STARTUP_TIMEOUT_MS } from "./conversation-backend.ts";
import { builtinAgent } from "./discovery.ts";
import type { WorkerCommand, WorkerPacket, WorkerStatus } from "./worker-protocol.ts";

const status: WorkerStatus = { conversationId: "9", working: false };

class Child extends EventEmitter {
	connected = true;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	stderr = new EventEmitter();
	packets: WorkerCommand[] = [];
	autoClose = true;
	send(packet: WorkerCommand, callback: (error: Error | null) => void): boolean {
		this.packets.push(packet);
		callback(null);
		if (this.autoClose && (packet.type === "pause" || packet.type === "cancel")) queueMicrotask(() => this.close());
		return true;
	}
	reply(packet: WorkerPacket): void {
		this.emit("message", packet);
	}
	close(signal?: NodeJS.Signals): void {
		this.connected = false;
		this.signalCode = signal ?? null;
		this.exitCode = signal ? null : 0;
		this.emit("close");
	}
}

function fixture(t: TestContext) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const directory = mkdtempSync(join(tmpdir(), "subagent-startup-"));
	const configHome = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = directory;
	t.after(() => {
		if (configHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = configHome;
		rmSync(directory, { recursive: true, force: true });
	});
	const child = new Child();
	const signals: NodeJS.Signals[] = [];
	const exits: Array<Error | undefined> = [];
	const worker = openConversationWorker(
		{
			name: "review",
			directory,
			request: { agent: builtinAgent(), task: "review", index: 0 },
			context: {
				cwd: directory,
				sessionId: "parent",
				sessionFile: join(directory, "parent.jsonl"),
				runId: "review",
				timeoutMs: 7_200_000,
			},
		},
		{ answer: assert.fail, exit: (error) => exits.push(error) },
		{
			spawn: (() => child as unknown as ChildProcess) as typeof spawn,
			signalProcessTree: (_child, signal) => {
				signals.push(signal);
				if (signal === "SIGKILL") {
					child.signalCode = signal;
					queueMicrotask(() => child.close(signal));
				}
			},
		},
	);
	t.after(() => worker.cancel());
	assert.equal(child.packets[0]?.type, "start", "initialization begins immediately, without polling");
	return { worker, child, signals, exits };
}

test("a cold worker can become ready after the old 20-second deadline", async (t) => {
	const { worker, child, signals } = fixture(t);
	let failure: unknown;
	void worker.ready.catch((error) => {
		failure = error;
	});
	t.mock.timers.tick(37_000);
	await Promise.resolve();
	assert.equal(failure, undefined);
	assert.deepEqual(signals, []);
	child.reply({ type: "ready", status });
	assert.deepEqual(await worker.ready, status);
	t.mock.timers.tick(WORKER_STARTUP_TIMEOUT_MS);
	assert.deepEqual(signals, [], "ready clears the startup watchdog");
	const pending = worker.status();
	await Promise.resolve();
	const packet = child.packets.at(-1)!;
	assert.equal(packet.type, "status");
	if (packet.type !== "status") assert.fail("Expected status request");
	child.reply({ type: "status", id: packet.id, status });
	assert.deepEqual(await pending, status, "slow startup leaves the connection usable");
});

test("hung initialization is killed at the bounded startup deadline and rejects waiting input", async (t) => {
	const { worker, signals, exits } = fixture(t);
	const ready = assert.rejects(worker.ready, /startup timed out after 120000ms/);
	const input = assert.rejects(worker.input("input", "review", false), /startup timed out after 120000ms/);
	t.mock.timers.tick(WORKER_STARTUP_TIMEOUT_MS - 1);
	assert.deepEqual(signals, []);
	t.mock.timers.tick(1);
	await Promise.all([ready, input]);
	assert.deepEqual(signals, ["SIGKILL"]);
	assert.equal(exits.length, 1);
	assert.match(exits[0]!.message, /startup timed out/);
});

test("startup stderr is bounded and cannot hide the timeout diagnostic", async (t) => {
	const { worker, child } = fixture(t);
	child.stderr.emit("data", "x".repeat(20_000));
	child.stderr.emit("data", "\nA harmless startup warning");
	const rejected = assert.rejects(worker.ready, (error: Error) => {
		assert.match(error.message, /^Subagent worker startup timed out after 120000ms:\n/);
		assert.match(error.message, /A harmless startup warning$/);
		assert.ok(error.message.length < 17_000);
		return true;
	});
	t.mock.timers.tick(WORKER_STARTUP_TIMEOUT_MS);
	await rejected;
});

for (const [action, timeout] of [
	["status", 20_000],
	["stop", 5_000],
] as const) {
	test(`${action} acknowledgment keeps its shorter timeout once ready`, async (t) => {
		const { worker, child, signals } = fixture(t);
		child.reply({ type: "ready", status });
		await worker.ready;
		const pending = action === "stop" ? worker.stop("stop") : worker.status();
		const rejected = assert.rejects(pending, new RegExp(`${action} acknowledgment timed out`));
		await Promise.resolve();
		t.mock.timers.tick(timeout - 1);
		assert.deepEqual(signals, []);
		t.mock.timers.tick(1);
		await rejected;
		assert.deepEqual(signals, ["SIGKILL"]);
	});
}

test("initialization failures propagate immediately instead of waiting for the startup timeout", async (t) => {
	const { worker, child, signals, exits } = fixture(t);
	const rejected = assert.rejects(worker.ready, /Native extension startup failed/);
	child.reply({ type: "error", error: "Native extension startup failed" });
	await rejected;
	t.mock.timers.tick(WORKER_STARTUP_TIMEOUT_MS);
	assert.deepEqual(signals, ["SIGKILL"], "failure clears the startup timer");
	assert.equal(exits.length, 1);
});

for (const action of ["pause", "cancel"] as const) {
	test(`${action} during hung startup still tears down within four seconds`, async (t) => {
		const { worker, child, signals, exits } = fixture(t);
		child.autoClose = false;
		const closing = worker[action]();
		const rejected = assert.rejects(worker.ready, /Subagent worker closed/);
		t.mock.timers.tick(2_000);
		assert.deepEqual(signals, ["SIGTERM"]);
		t.mock.timers.tick(2_000);
		await Promise.all([closing, rejected]);
		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
		assert.deepEqual(exits, [undefined], "deliberate shutdown is not a worker failure");
		t.mock.timers.tick(WORKER_STARTUP_TIMEOUT_MS);
		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"], "teardown clears the startup timer");
	});
}
