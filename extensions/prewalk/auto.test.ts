import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { automaticPrewalk, lunaModel, prewalkDecision, scoutingPrompt, shouldConsiderPrewalk } from "./auto.ts";

function reply(text: string, stopReason: "stop" | "toolUse" = "stop"): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason } as AssistantMessage;
}

test("automatic gate skips untrusted, subagent, short and manual-prewalk prompts", () => {
	assert.equal(shouldConsiderPrewalk("Investigate login", true, false), true);
	assert.equal(shouldConsiderPrewalk("Investigate login", false, false), false);
	assert.equal(shouldConsiderPrewalk("Investigate login", true, true), false);
	assert.equal(shouldConsiderPrewalk("go", true, false), false);
	assert.equal(shouldConsiderPrewalk("Investigate login " + "x".repeat(4000), true, false), true);
	assert.equal(shouldConsiderPrewalk("Investigate login [Local prewalk, files]", true, false), false);
	assert.deepEqual(prewalkDecision(reply("YES: inspect login files")), {
		needed: true,
		rationale: "inspect login files",
	});
	assert.deepEqual(prewalkDecision(reply("NO: general question")), {
		needed: false,
		rationale: "general question",
	});
	assert.equal(prewalkDecision(reply("YES", "toolUse")), undefined);
	assert.equal(prewalkDecision(reply("maybe")), undefined);
	assert.equal(prewalkDecision(reply(`NO: ${"x".repeat(200)}`))?.rationale.length, 160);
});

test("long prompts stay eligible while Luna receives only the bounded head and tail", async () => {
	const prompt = `Investigate login ${"a".repeat(4000)} FIX session routing`;
	const excerpt = scoutingPrompt(prompt);
	assert.equal(excerpt.length, 3000);
	assert.match(excerpt, /^Investigate login/);
	assert.match(excerpt, /FIX session routing$/);
	assert.match(excerpt, /Middle of prompt omitted/);
	assert.equal(scoutingPrompt("Investigate login"), "Investigate login");
	let calls = 0;
	await automaticPrewalk("/nonexistent", prompt, async (context) => {
		calls++;
		assert.equal(context.messages[0]?.role, "user");
		assert.equal(context.messages[0]?.content, excerpt);
		return reply("NO: no exploration needed");
	});
	assert.equal(calls, 1);
});

test("Luna selection honors the session scope and requires configured auth", () => {
	const luna = { provider: "example", id: "luna" };
	const other = { provider: "example", id: "expensive" };
	const registry = { getAvailable: () => [other, luna], hasConfiguredAuth: () => true };
	const context = { modelRegistry: registry, scopedModels: [{ model: other }] } as unknown as Pick<
		ExtensionContext,
		"scopedModels" | "modelRegistry"
	>;
	assert.equal(lunaModel(context), undefined);
	assert.equal(lunaModel({ ...context, scopedModels: [] })?.id, "luna");
	assert.equal(
		lunaModel({
			...context,
			modelRegistry: { ...registry, hasConfiguredAuth: () => false } as unknown as ExtensionContext["modelRegistry"],
			scopedModels: [],
		}),
		undefined,
	);
});

test("NO classification does not scan or start exploration", async () => {
	let calls = 0;
	const decisions: string[] = [];
	const report = await automaticPrewalk(
		"/nonexistent",
		"Explain the weather forecast",
		async (_context, thinking) => {
			calls++;
			assert.equal(thinking, "off");
			return reply("NO: general knowledge request");
		},
		undefined,
		(decision) => decisions.push(decision.rationale),
	);
	assert.equal(report, undefined);
	assert.equal(calls, 1);
	assert.deepEqual(decisions, ["general knowledge request"]);
});

test("Luna can read a search result but cannot read unrelated files", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "prewalk-auto-"));
	try {
		await mkdir(path.join(cwd, "src"));
		await writeFile(path.join(cwd, "src", "login.ts"), "export function login() { return true; }\n");
		await writeFile(path.join(cwd, "unrelated.ts"), "private value\n");
		let calls = 0;
		const report = await automaticPrewalk(cwd, "Investigate the login flow", async (context: Context, thinking) => {
			calls++;
			if (calls === 1) return reply("YES");
			assert.equal(thinking, "low");
			if (calls === 2) {
				assert.match(JSON.stringify(context.messages), /src\/login.ts/);
				return {
					...reply("", "toolUse"),
					content: [
						{ type: "toolCall", id: "a", name: "read", arguments: { path: "src/login.ts" } },
						{ type: "toolCall", id: "b", name: "read", arguments: { path: "unrelated.ts" } },
					],
				};
			}
			assert.match(JSON.stringify(context.messages), /export function login/);
			assert.match(JSON.stringify(context.messages), /Not in the bounded search results/);
			return reply("src/login.ts:1 defines login; verify its callers.");
		});
		assert.equal(calls, 3);
		assert.match(report ?? "", /verify before relying/);
		assert.match(report ?? "", /src\/login.ts:1/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("Luna can continue reading a long file by byte offset", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "prewalk-chunks-"));
	try {
		await writeFile(path.join(cwd, "login.ts"), `login\n${"a".repeat(32 * 1024)}\nend of login\n`);
		let calls = 0;
		await automaticPrewalk(cwd, "Investigate login", async (context) => {
			calls++;
			if (calls === 1) return reply("YES: inspect login");
			if (calls === 2)
				return {
					...reply("", "toolUse"),
					content: [{ type: "toolCall", id: "first", name: "read", arguments: { path: "login.ts" } }],
				};
			if (calls === 3) {
				const result = context.messages.at(-1);
				assert.equal(result?.role, "toolResult");
				if (result?.role === "toolResult") {
					assert.match(JSON.stringify(result.content), /more available: read with offset 32768/);
					assert.doesNotMatch(JSON.stringify(result.content), /end of login/);
				}
				return {
					...reply("", "toolUse"),
					content: [
						{ type: "toolCall", id: "second", name: "read", arguments: { path: "login.ts", offset: 32768 } },
					],
				};
			}
			assert.match(JSON.stringify(context.messages.at(-1)), /end of login/);
			assert.match(JSON.stringify(context.messages.at(-1)), /end of file/);
			return reply("login.ts contains the complete login context.");
		});
		assert.equal(calls, 4);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
