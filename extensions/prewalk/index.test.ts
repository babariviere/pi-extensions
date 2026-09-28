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

test("automatic prewalk runs only on the first fresh-session prompt and explains Luna's decision", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "prewalk-ui-"));
	try {
		await writeFile(path.join(cwd, "login.ts"), "export function login() {}\n");
		let hook: ((event: { prompt: string }, context: ExtensionContext) => Promise<unknown>) | undefined;
		let sessionStart: ((_event: unknown, context: ExtensionContext) => void) | undefined;
		prewalkExtension({
			on: (event: string, handler: unknown) => {
				if (event === "before_agent_start") hook = handler as typeof hook;
				if (event === "session_start") sessionStart = handler as typeof sessionStart;
			},
			registerCommand: () => {},
		} as unknown as ExtensionAPI);
		assert.ok(hook);
		assert.ok(sessionStart);
		const status: (string | undefined)[] = [];
		const notices: string[] = [];
		let branch: { type: "message"; message: { role: "user" } }[] = [];
		let available = [{ provider: "example", id: "luna" }];
		let replies = [reply("NO: this question is general knowledge")];
		const context = {
			cwd,
			hasUI: true,
			isProjectTrusted: () => true,
			sessionManager: { getBranch: () => branch },
			scopedModels: [],
			modelRegistry: {
				getAvailable: () => available,
				hasConfiguredAuth: () => true,
				complete: async () => {
					const next = replies.shift();
					if (!next) throw new Error("Luna unavailable");
					return next;
				},
			},
			ui: {
				setStatus: (_key: string, text: string | undefined) => status.push(text),
				notify: (text: string) => notices.push(text),
			},
		} as unknown as ExtensionContext;
		sessionStart({}, context);
		assert.equal(await hook({ prompt: "Investigate the login flow" }, context), undefined);
		assert.deepEqual(status.splice(0), ["Prewalk: checking…", undefined]);
		assert.deepEqual(notices.splice(0), ["Prewalk skipped: this question is general knowledge"]);

		replies = [reply("YES: login code spans files"), reply("login.ts:1 contains login; verify callers")];
		assert.equal(await hook({ prompt: "Investigate the login flow" }, context), undefined);
		assert.equal(replies.length, 2);
		assert.deepEqual(status.splice(0), []);

		// /new starts a fresh branch and permits exactly one new classification.
		sessionStart({}, context);
		const result = (await hook({ prompt: "Investigate the login flow" }, context)) as {
			message: { customType: string; content: string; display: boolean };
		};
		assert.equal(result.message.customType, "prewalk.report");
		assert.equal(result.message.display, true);
		assert.match(result.message.content, /login.ts:1/);
		assert.deepEqual(status.splice(0), ["Prewalk: checking…", "Prewalk: exploring…", undefined]);
		assert.deepEqual(notices.splice(0), ["Prewalk recommended: login code spans files"]);

		// Resumed or reloaded sessions with a prior user message never reclassify.
		branch = [{ type: "message", message: { role: "user" } }];
		sessionStart({}, context);
		replies = [reply("YES: would have prewalked")];
		assert.equal(await hook({ prompt: "Investigate the login flow" }, context), undefined);
		assert.equal(replies.length, 1);
		assert.deepEqual(status.splice(0), []);

		// The first opportunity is consumed even when that prompt is ineligible.
		branch = [];
		sessionStart({}, context);
		assert.equal(await hook({ prompt: "go" }, context), undefined);
		assert.equal(await hook({ prompt: "Investigate the login flow" }, context), undefined);
		assert.equal(replies.length, 1);
		assert.deepEqual(status.splice(0), []);

		// A missing Luna on the first prompt does not defer the attempt to a later prompt.
		sessionStart({}, context);
		available = [];
		assert.equal(await hook({ prompt: "Investigate the login flow" }, context), undefined);
		available = [{ provider: "example", id: "luna" }];
		assert.equal(await hook({ prompt: "Investigate the login flow" }, context), undefined);
		assert.equal(replies.length, 1);
		assert.deepEqual(status.splice(0), []);

		// A manual /prewalk request consumes the first prompt without Luna.
		sessionStart({}, context);
		assert.equal(
			await hook({ prompt: "Investigate login [Local prewalk, existing search results]" }, context),
			undefined,
		);
		assert.equal(await hook({ prompt: "Investigate the login flow" }, context), undefined);
		assert.equal(replies.length, 1);
		assert.deepEqual(status.splice(0), []);

		sessionStart({}, context);
		replies = [];
		assert.equal(await hook({ prompt: "Investigate the login flow" }, context), undefined);
		assert.deepEqual(status.splice(0), ["Prewalk: checking…", undefined]);
		assert.deepEqual(notices.splice(0), []);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
