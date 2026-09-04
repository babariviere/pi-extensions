import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CapturedToolCatalog } from "./capture/catalog.ts";
import { SandboxController } from "./sandbox/controller.ts";
import { SANDBOX_REQUEST_EVENT, SANDBOX_STATE_EVENT, type SandboxStateEvent } from "./sandbox/protocol.ts";
import { SpindleState } from "./spindle-state.ts";

const originalApply = SandboxController.prototype.apply;
const temporaryDirectories: string[] = [];

afterEach(async () => {
	SandboxController.prototype.apply = originalApply;
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

class TestEvents {
	readonly emitted: Array<{ name: string; payload: unknown }> = [];
	readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();

	on(name: string, listener: (payload: unknown) => void): () => void {
		const listeners = this.#listeners.get(name) ?? new Set();
		listeners.add(listener);
		this.#listeners.set(name, listeners);
		return () => listeners.delete(listener);
	}

	emit(name: string, payload: unknown): void {
		this.emitted.push({ name, payload });
		for (const listener of this.#listeners.get(name) ?? []) listener(payload);
	}
}

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
};

const createState = async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "spindle-state-test-"));
	temporaryDirectories.push(cwd);
	const events = new TestEvents();
	const notifications: Array<{ message: string; level: string }> = [];
	const pi = { events } as unknown as ExtensionAPI;
	const context = {
		cwd,
		hasUI: true,
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => "session-test",
			getSessionFile: () => path.join(cwd, "session.jsonl"),
		},
		scopedModels: [],
		modelRegistry: { getAvailable: async () => [] },
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	} as unknown as ExtensionContext;
	const state = new SpindleState(pi, new CapturedToolCatalog());
	await state.initialize(context);
	return { state, context, events, notifications };
};

const stateEvents = (events: TestEvents) => events.emitted.filter((event) => event.name === SANDBOX_STATE_EVENT);

const offState = (): SandboxStateEvent => ({
	mode: "off",
	enforcing: false,
	osEnforced: false,
	writableRoots: 0,
	source: "request",
});

test("an active sandbox request publishes state and notifies the current session", async () => {
	const { state, events, notifications } = await createState();
	const initialEvents = stateEvents(events).length;

	events.emit(SANDBOX_REQUEST_EVENT, { policy: { mode: "off" }, reason: "test request" });
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(stateEvents(events).length, initialEvents + 1);
	assert.equal(
		notifications.some(({ message, level }) => level === "info" && message.includes("test request")),
		true,
	);
	await state.shutdown();
});

test("a deferred sandbox apply finishing during session shutdown uses no stale pi or context", async () => {
	const gate = deferred<SandboxStateEvent>();
	let calls = 0;
	SandboxController.prototype.apply = async function (...args) {
		calls++;
		if (calls === 1) return originalApply.apply(this, args);
		return gate.promise;
	};
	const { state, events, notifications } = await createState();
	const initialEvents = stateEvents(events).length;
	const initialNotifications = notifications.length;

	events.emit(SANDBOX_REQUEST_EVENT, { policy: { mode: "off" }, reason: "night planning approved" });
	const shutdown = state.shutdown();
	gate.resolve(offState());
	await shutdown;

	assert.equal(stateEvents(events).length, initialEvents);
	assert.equal(notifications.length, initialNotifications);
});

test("a deferred sandbox failure during replacement is handled without stale notification", async () => {
	const gate = deferred<SandboxStateEvent>();
	let calls = 0;
	SandboxController.prototype.apply = async function (...args) {
		calls++;
		if (calls === 1) return originalApply.apply(this, args);
		return gate.promise;
	};
	const { state, events, notifications } = await createState();
	const initialNotifications = notifications.length;
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
	try {
		events.emit(SANDBOX_REQUEST_EVENT, { policy: { mode: "off" }, reason: "night planning approved" });
		const shutdown = state.shutdown();
		gate.reject(new Error("late apply failure"));
		await shutdown;
	} finally {
		console.warn = originalWarn;
	}

	assert.equal(notifications.length, initialNotifications);
	assert.equal(
		warnings.some((message) => message.includes("late apply failure")),
		true,
	);
});

test("an async sandbox request failure is handled and reported while the session is active", async () => {
	let calls = 0;
	SandboxController.prototype.apply = async function (...args) {
		calls++;
		if (calls === 1) return originalApply.apply(this, args);
		throw new Error("apply exploded");
	};
	const { state, events, notifications } = await createState();
	const errors: string[] = [];
	const originalError = console.error;
	console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
	try {
		events.emit(SANDBOX_REQUEST_EVENT, { policy: { mode: "off" }, reason: "broken request" });
		await new Promise<void>((resolve) => setImmediate(resolve));
	} finally {
		console.error = originalError;
	}

	assert.equal(
		errors.some((message) => message.includes("apply exploded")),
		true,
	);
	assert.equal(
		notifications.some(({ message, level }) => level === "error" && message.includes("apply exploded")),
		true,
	);
	await state.shutdown();
});
