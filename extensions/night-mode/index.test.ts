import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import nightMode from "./index.ts";

type Handler = (event: unknown, context: unknown) => unknown;
type Command = { handler: (args: string, context: unknown) => Promise<void> };

test("continues a night run after a cancelled command settles", async () => {
	const root = mkdtempSync(join(tmpdir(), "night-mode-cancel-"));
	const originalCwd = process.cwd();
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const sent: Array<{ message: string; options: unknown }> = [];
	const handlers = new Map<string, Handler>();
	let command: Command | undefined;

	try {
		const promptPath = join(root, "prompt.md");
		const reportPath = join(root, "report.md");
		const todoPath = join(root, "todos");
		const agentDir = join(root, "agent");
		mkdirSync(join(root, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(promptPath, "Continue the night run.");
		writeFileSync(
			join(root, ".pi", "settings.json"),
			JSON.stringify({
				nightMode: {
					promptPath,
					reportPathTemplate: reportPath,
					todoPath,
					sandboxRoot: "",
					sandboxMode: "off",
					mcpReadOnly: false,
				},
			}),
		);
		process.chdir(root);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const api = {
			on(event: string, handler: Handler): void {
				handlers.set(event, handler);
			},
			events: {
				on(): () => void {
					return () => {};
				},
				emit(): void {},
			},
			registerCommand(_name: string, value: unknown): void {
				command = value as Command;
			},
			sendUserMessage(message: string, options?: unknown): void {
				sent.push({ message, options });
			},
		};
		nightMode(api as unknown as ExtensionAPI);

		const staleCommandContext = {
			isIdle: () => false,
			ui: { notify: () => {}, setStatus: () => {} },
			sessionManager: { getSessionId: () => "test-session" },
		};
		await command?.handler("start", staleCommandContext);
		assert.ok(command);
		sent.length = 0;

		const settledContext = { isIdle: () => true };
		handlers.get("agent_settled")?.({}, settledContext);

		assert.equal(sent.length, 1);
		assert.equal(sent[0].options, undefined, "the continuation must start a new turn after cancellation");
	} finally {
		process.chdir(originalCwd);
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});
