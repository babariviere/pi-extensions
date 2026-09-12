import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CODE_MODE_PROVIDER_DISCOVER_EVENT,
	CODE_MODE_PROVIDER_REGISTER_EVENT,
	type CodeModeInvocationContext,
	type CodeModeProvider,
	type CodeModeProviderDiscovery,
	type CodeModeProviderRegistration,
} from "../code-mode/protocol.ts";
import { assertReadAllowed, assertWriteAllowed, resolveSandboxPolicy } from "../code-mode/sandbox/policy.ts";
import { NIGHT_MODE_PLANNING_QUERY_EVENT, type NightModePlanningQuery } from "../night-mode/protocol.ts";
import todosExtension from "./index.ts";

// The sandbox applies to a child agent's Pi tools and shell. Providers run in
// Pi's trusted host process, so the todo provider keeps the sole write capability.
test("a child cannot access the todo store directly while the typed todo provider can write it", async () => {
	const store = mkdtempSync(join(tmpdir(), "todo-sandbox-"));
	const previous = process.env.PI_TODO_PATH;
	let registration: CodeModeProviderRegistration | undefined;
	let discover: ((value: unknown) => void) | undefined;
	let nativeToolRegistered = false;
	let planning = false;
	try {
		process.env.PI_TODO_PATH = store;
		todosExtension({
			on: () => {},
			events: {
				on: (event: string, handler: (value: unknown) => void) => {
					if (event === CODE_MODE_PROVIDER_DISCOVER_EVENT) discover = handler;
					return () => {};
				},
				emit: (event: string, value: unknown) => {
					if (event === CODE_MODE_PROVIDER_REGISTER_EVENT) registration = value as CodeModeProviderRegistration;
					if (event === NIGHT_MODE_PLANNING_QUERY_EVENT) (value as NightModePlanningQuery).planning = planning;
				},
			},
			registerTool: () => {
				nativeToolRegistered = true;
			},
			registerCommand: () => {},
		} as any);

		assert.equal(nativeToolRegistered, false);
		assert.equal(registration?.version, 1);
		assert.equal(registration?.overwrite, true);
		const provider = registration?.provider;
		assert.ok(provider);
		assert.equal(provider.name, "todo");

		let discoveredProvider: CodeModeProvider | undefined;
		const discovery: CodeModeProviderDiscovery = {
			version: 1,
			register: (candidate) => {
				discoveredProvider = candidate;
			},
		};
		discover?.(discovery);
		assert.equal(discoveredProvider, provider);

		const extensionContext = {
			cwd: store,
			hasUI: false,
			sessionManager: { getSessionId: () => "child", getSessionFile: () => "/tmp/child.json" },
		} as any;
		const invocationContext = {
			cwd: store,
			signal: new AbortController().signal,
			parentToolCallId: "parent",
			nestedToolCallId: "nested",
			extensionContext,
			update: () => {},
		} satisfies CodeModeInvocationContext;

		const descriptors = await provider.list({}, invocationContext);
		assert.deepEqual(
			descriptors.map((descriptor) => descriptor.name),
			["list", "listAll", "get", "create", "update", "append", "delete", "claim", "release"],
		);
		assert.equal(await provider.describe("list-all", invocationContext), undefined);
		assert.ok((await provider.describe("create", invocationContext))?.inputSchema);

		const policy = resolveSandboxPolicy(
			{ mode: "workspace-write", allowWrite: [store], denyRead: [store] },
			{ cwd: store, home: store, platform: "linux", env: {}, tmp: "/tmp" },
		);
		const directPath = join(store, "bypass.md");
		assert.throws(() => assertReadAllowed(policy, directPath), /denied by mode/);
		assert.throws(() => assertWriteAllowed(policy, directPath), /denied by mode/);

		const created = (await provider.invoke(
			"create",
			{ title: "Todo provider remains available", tags: ["test"], body: "Initial" },
			invocationContext,
		)) as any;
		assert.match(created.id, /^TODO-[a-f0-9]{8}$/);
		assert.equal(created.title, "Todo provider remains available");
		assert.equal(readdirSync(store).filter((entry) => entry.endsWith(".md")).length, 1);
		assert.equal(existsSync(directPath), false);

		const appended = (await provider.invoke(
			"append",
			{ id: created.id, body: "Progress" },
			invocationContext,
		)) as any;
		assert.equal(appended.body, "Initial\n\nProgress\n");
		const claimed = (await provider.invoke("claim", { id: created.id }, invocationContext)) as any;
		assert.equal(claimed.assigned_to_session, "child");
		const released = (await provider.invoke("release", { id: created.id }, invocationContext)) as any;
		assert.equal(released.assigned_to_session, undefined);
		const closed = (await provider.invoke("update", { id: created.id, status: "closed" }, invocationContext)) as any;
		assert.equal(closed.status, "closed");
		assert.deepEqual(await provider.invoke("list", {}, invocationContext), []);
		assert.equal(((await provider.invoke("listAll", {}, invocationContext)) as any[])[0]?.id, created.id);
		planning = true;
		assert.equal(((await provider.invoke("get", { id: created.id }, invocationContext)) as any).id, created.id);
		await assert.rejects(
			provider.invoke("update", { id: created.id, title: "blocked" }, invocationContext),
			/planning is read-only/,
		);
		planning = false;
		assert.equal(
			((await provider.invoke("get", { id: created.id }, invocationContext)) as any).body,
			"Initial\n\nProgress\n",
		);
		await assert.rejects(provider.invoke("list-all", {}, invocationContext), /Unknown todo action: list-all/);
		await assert.rejects(provider.invoke("get", {}, invocationContext), /id required/);
		assert.equal(((await provider.invoke("delete", { id: created.id }, invocationContext)) as any).id, created.id);
		assert.deepEqual(await provider.invoke("listAll", {}, invocationContext), []);
	} finally {
		if (previous === undefined) delete process.env.PI_TODO_PATH;
		else process.env.PI_TODO_PATH = previous;
		rmSync(store, { recursive: true, force: true });
	}
});
