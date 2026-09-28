import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { automaticPrewalk, lunaModel, prewalkDecision, shouldConsiderPrewalk } from "./auto.ts";

function reply(text: string, stopReason: "stop" | "toolUse" = "stop"): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason } as AssistantMessage;
}

test("automatic gate skips untrusted, subagent, short and manual-prewalk prompts", () => {
	assert.equal(shouldConsiderPrewalk("Investigate login", true, false), true);
	assert.equal(shouldConsiderPrewalk("Investigate login", false, false), false);
	assert.equal(shouldConsiderPrewalk("Investigate login", true, true), false);
	assert.equal(shouldConsiderPrewalk("go", true, false), false);
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
