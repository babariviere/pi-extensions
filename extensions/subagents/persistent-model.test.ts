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
];
test("host model is qualified and authorized by provider, availability and price", async () => {
	await withParentSession(async () => {
		const cwd = process.env.PI_CODING_AGENT_DIR!;
		const choice = { model: "cheap", thinking: "low", parentProvider: "test", models };
		assert.equal(validateHostModel(choice, cwd).model, "test/cheap");
		assert.throws(() => validateHostModel({ ...choice, model: undefined }, cwd), /resolved parent model/);
		assert.throws(() => validateHostModel({ ...choice, model: "other/cheap" }, cwd), /caller's provider/);
		assert.throws(() => validateHostModel({ ...choice, model: "missing" }, cwd), /unavailable/);
		assert.throws(() => validateHostModel({ ...choice, model: "expensive" }, cwd), /price ceiling/);
		assert.throws(() => validateHostModel({ ...choice, models: models.slice(1) }, cwd), /Cannot enforce/);
		for (const price of [NaN, Infinity, -1]) {
			assert.throws(
				() => validateHostModel({ ...choice, models: [...models.slice(0, 2), model("cheap", price, 1)] }, cwd),
				/no pricing/,
			);
		}
	});
});
test("an untrusted project cannot bypass user enabledModels; trusted project policy is honored", async () => {
	await withParentSession(async () => {
		const cwd = process.env.PI_CODING_AGENT_DIR!;
		await writeFile(join(cwd, "settings.json"), JSON.stringify({ enabledModels: ["test/cheap"] }));
		await mkdir(join(cwd, ".pi"));
		await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["test/claude-opus-5-5"] }));
		const choice = { model: "claude-opus-5-5", parentProvider: "test", models };
		assert.throws(() => validateHostModel(choice, cwd, false), /enabledModels/);
		assert.equal(validateHostModel(choice, cwd, true).model, "test/claude-opus-5-5");
		assert.equal(validateHostModel({ ...choice, model: "cheap:low" }, cwd, false).model, "test/cheap:low");
	});
});
