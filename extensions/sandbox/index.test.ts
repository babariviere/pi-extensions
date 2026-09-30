import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { SandboxController, type SandboxSource } from "./controller.ts";
import { SandboxSession, assertNativeMcpCall } from "./index.ts";
import type { SandboxRuntime } from "./manager.ts";
import { normalizeMcpReadOnlyConfig } from "./mcp-policy.ts";
import { NATIVE_SANDBOX_TOOL_NAMES } from "./native-tools.ts";
import type { SandboxPolicy } from "./policy.ts";
import {
	SANDBOX_WRAP_COMMAND_EVENT,
	SANDBOX_WRITE_GUARD_EVENT,
	sandboxGuardWrite,
	sandboxWrapCommand,
} from "./service.ts";

class FakeSession extends SandboxSession {
	protected override createController(policy: SandboxPolicy, source: SandboxSource): SandboxController {
		return new SandboxController(
			policy,
			source,
			async () =>
				({
					initialize: async () => {},
					wrapWithSandbox: async (command: string) => `wrapped ${command}`,
					wrapArgv: async (argv: readonly string[]) => [...argv],
					reset: async () => {},
				}) satisfies SandboxRuntime,
		);
	}
}

function harness() {
	const infos = new Map<string, ToolInfo>(
		NATIVE_SANDBOX_TOOL_NAMES.map((name) => [name, { name, sourceInfo: { path: `builtin:${name}` } } as ToolInfo]),
	);
	const definitions = new Map<string, ToolDefinition<any, any>>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		registerCommand: () => {},
		getSettings: () => ({}),
		getAllTools: () => [...infos.values()],
		registerTool: (tool: ToolDefinition<any, any>) => {
			definitions.set(tool.name, tool);
			infos.set(tool.name, { ...tool, sourceInfo: { path: "/sandbox/index.ts" } } as unknown as ToolInfo);
		},
		events: {
			on(name: string, listener: (value: unknown) => void) {
				let set = listeners.get(name);
				if (!set) listeners.set(name, (set = new Set()));
				set.add(listener);
				return () => set!.delete(listener);
			},
			emit(name: string, value: unknown) {
				for (const listener of listeners.get(name) ?? []) {
					try {
						listener(value);
					} catch {}
				}
			},
		},
	} as unknown as ExtensionAPI;
	return { pi, infos, definitions, handlers, listeners };
}

test("native direct and nested core calls share policy, and jobs/patches use the same service", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "native-sandbox-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "profile");
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(cwd, { recursive: true, force: true });
	});
	const blocked = join(cwd, "blocked");
	mkdirSync(blocked);
	const ctx = {
		cwd,
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "test" },
		ui: { notify: () => {}, setStatus: () => {} },
	} as unknown as ExtensionContext;
	const host = harness();
	const session = new FakeSession(host.pi);
	await session.initialize(ctx);
	t.after(() => session.close());
	await session.apply({ mode: "workspace-write", denyRead: [blocked] }, ctx);
	assert.equal(
		(host.definitions.get("bash")?.outputSchema as unknown as { type?: string })?.type,
		"object",
		"native structured shell results are retained",
	);
	assert.equal(await sandboxWrapCommand(host.pi, "echo hi"), "wrapped echo hi");
	assert.throws(() => sandboxGuardWrite(host.pi, join(blocked, "secret.txt")), /denied by mode/);
	for (const parentToolCallId of [undefined, "native"]) {
		const result = await host.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "read",
				toolCallId: "native/1",
				parentToolCallId,
				input: { path: join(blocked, "secret.txt") },
			},
			ctx,
		);
		assert.equal(result.block, true);
		assert.match(result.reason, /denied by mode/);
	}
	const patch = await host.handlers.get("tool_call")!(
		{
			type: "tool_call",
			toolName: "applyPatch",
			toolCallId: "patch",
			input: { patch: `*** Begin Patch\n*** Add File: ${join(blocked, "secret.txt")}\n+no\n*** End Patch` },
		},
		ctx,
	);
	assert.equal(patch.block, true);
	host.infos.set("bash", { name: "bash", sourceInfo: { path: "/remote/index.ts" } } as ToolInfo);
	assert.match(
		(await host.handlers.get("tool_call")!({ toolName: "bash", input: { command: "echo hi" } }, ctx)).reason,
		/sibling override/,
	);
	await session.close();
	assert.equal(host.listeners.get(SANDBOX_WRAP_COMMAND_EVENT)?.size, 0);
	assert.equal(host.listeners.get(SANDBOX_WRITE_GUARD_EVENT)?.size, 0);
	await assert.rejects(sandboxWrapCommand(host.pi, "echo hi"), /require the sandbox extension/);
});

test("MCP namespace identifies servers with underscores and cannot loosen unknown-tool policy", () => {
	const config = normalizeMcpReadOnlyConfig({ readOnly: true, servers: { my__server: { allow: ["read__item"] } } });
	const info = {
		name: "mcp__my__server__read__item",
		namespace: { name: "mcp__my__server" },
		annotations: { readOnlyHint: true },
	} as ToolInfo;
	assert.doesNotThrow(() => assertNativeMcpCall(config, info, {}));
	assert.throws(() => assertNativeMcpCall(config, { ...info, name: "mcp__my__server__send__item" }, {}), /refused/);
	const heuristic = normalizeMcpReadOnlyConfig({ readOnly: true, unknownToolPolicy: "allow-reads" });
	assert.throws(
		() =>
			assertNativeMcpCall(
				heuristic,
				{ name: "mcp__acme__read_item", annotations: { destructiveHint: true } } as ToolInfo,
				{},
			),
		/hints disagree/,
	);
});
