import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { validateHostModel } from "./persistent-model.ts";
import { withParentSession } from "./test-host.ts";

const model = (id: string, input: number, output: number): Model<any> =>
	({ id, provider: "test", cost: { input, output } }) as Model<any>;
const models = [
	model("claude-opus-5-5", 10, 20),
	model("gpt-6.1-sol", 15, 10),
	model("cheap", 1, 2),
	model("expensive", 20, 20),
	{ id: "cheap", provider: "other", cost: { input: 1, output: 2 } } as Model<any>,
	{ id: "expensive", provider: "other", cost: { input: 20, output: 20 } } as Model<any>,
];
test("available host models are qualified across providers regardless of price", async () => {
	await withParentSession(async () => {
		const cwd = process.env.PI_CODING_AGENT_DIR!;
		const choice = { model: "cheap", thinking: "low", parentProvider: "test", models };
		assert.equal(validateHostModel(choice, cwd).model, "test/cheap");
		assert.throws(() => validateHostModel({ ...choice, model: undefined }, cwd), /resolved parent model/);
		assert.equal(validateHostModel({ ...choice, model: "other/cheap" }, cwd).model, "other/cheap");
		assert.equal(validateHostModel({ ...choice, model: "other/expensive" }, cwd).model, "other/expensive");
		assert.throws(() => validateHostModel({ ...choice, model: "nowhere/cheap" }, cwd), /unavailable/);
		assert.throws(() => validateHostModel({ ...choice, model: "missing" }, cwd), /unavailable/);
		assert.equal(validateHostModel({ ...choice, model: "expensive" }, cwd).model, "test/expensive");
	});
});
test("availability does not depend on candidate or reference pricing", async () => {
	await withParentSession(async () => {
		const cwd = process.env.PI_CODING_AGENT_DIR!;
		const models = [{ id: "custom", provider: "test" } as Model<any>];
		const choice = { model: "custom:high", parentProvider: "test", models };
		assert.equal(validateHostModel(choice, cwd).model, "test/custom:high");
	});
});
test("an untrusted project cannot bypass user enabledModels; trusted project policy is honored", async () => {
	await withParentSession(async () => {
		const cwd = process.env.PI_CODING_AGENT_DIR!;
		await writeFile(join(cwd, "settings.json"), JSON.stringify({ enabledModels: ["test/cheap"] }));
		await mkdir(join(cwd, ".pi"));
		await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["test/expensive"] }));
		const choice = { model: "expensive", parentProvider: "test", models };
		assert.throws(() => validateHostModel(choice, cwd, false), /enabledModels/);
		assert.equal(validateHostModel(choice, cwd, true).model, "test/expensive");
		assert.equal(validateHostModel({ ...choice, model: "cheap:low" }, cwd, false).model, "test/cheap:low");
	});
});
