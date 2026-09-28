import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import prewalkExtension from "./index.ts";

const reply = (text: string) =>
	({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }) as AssistantMessage;

test("automatic prewalk status tracks checking, exploration, decline and failure, then clears", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "prewalk-ui-"));
	try {
		await writeFile(path.join(cwd, "login.ts"), "export function login() {}\n");
		let hook: ((event: { prompt: string }, context: ExtensionContext) => Promise<unknown>) | undefined;
		prewalkExtension({
			on: (event: string, handler: unknown) => {
				if (event === "before_agent_start") hook = handler as typeof hook;
			},
			registerCommand: () => {},
		} as unknown as ExtensionAPI);
		assert.ok(hook);
		const status: (string | undefined)[] = [];
		let replies = [reply("NO")];
		const context = {
			cwd,
			hasUI: true,
			isProjectTrusted: () => true,
			scopedModels: [],
			modelRegistry: {
				getAvailable: () => [{ provider: "example", id: "luna" }],
				hasConfiguredAuth: () => true,
				complete: async () => {
					const next = replies.shift();
					if (!next) throw new Error("Luna unavailable");
					return next;
				},
			},
			ui: { setStatus: (_key: string, text: string | undefined) => status.push(text) },
		} as unknown as ExtensionContext;
		assert.equal(await hook({ prompt: "Investigate the login flow" }, context), undefined);
		assert.deepEqual(status.splice(0), ["Prewalk: checking…", undefined]);

		replies = [reply("YES"), reply("login.ts:1 contains login; verify callers")];
		const result = (await hook({ prompt: "Investigate the login flow" }, context)) as {
			message: { content: string };
		};
		assert.match(result.message.content, /login.ts:1/);
		assert.deepEqual(status.splice(0), ["Prewalk: checking…", "Prewalk: exploring…", undefined]);

		replies = [];
		assert.equal(await hook({ prompt: "Investigate the login flow" }, context), undefined);
		assert.deepEqual(status.splice(0), ["Prewalk: checking…", undefined]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
