import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reviewNightPlan } from "./plan.ts";

const task = {
	title: "Scan",
	goal: "Read Slack",
	repository: "/repo",
	definitionOfDone: "Return summary",
	category: "slack",
	outputs: [],
	permissions: [],
};
type Widget = { render(width: number): string[]; handleInput(input: string): void };
type Factory = (tui: object, theme: object, bindings: object, done: (value: unknown) => void) => Widget;
function reviewContext(keys: string[][], edited?: string) {
	const notifications: string[] = [];
	const renders: string[] = [];
	let turn = 0;
	const ctx = {
		mode: "tui",
		ui: {
			notify: (text: string) => notifications.push(text),
			editor: async () => edited,
			custom: async (factory: Factory) => {
				let result: unknown;
				const widget = factory(
					{ requestRender() {} },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					{},
					(value) => {
						result = value;
					},
				);
				renders.push(widget.render(120).join("\n"));
				assert.ok(turn < keys.length, "review should terminate");
				for (const key of keys[turn++]) widget.handleInput(key);
				return result;
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, notifications, renders };
}
it("shows omissions and permissions while approving only checked tasks", async () => {
	const mock = reviewContext([[" ", "\r"]]);
	const result = await reviewNightPlan(
		mock.ctx,
		[task, { ...task, title: "Unselected insights", category: "insights" }],
		[{ category: "ci", reason: "No failing runs" }],
	);
	assert.equal(result?.length, 1);
	assert.equal(result?.[0].title, "Scan");
	assert.match(mock.renders[0], /Not proposed: ci: No failing runs/);
	assert.match(mock.renders[0], /permissions: read-only/);
});
it("rechecks MCP permissions after editing and permits cancellation", async () => {
	const mock = reviewContext(
		[[" ", "e"], ["\r"], ["\u001b"]],
		JSON.stringify({ ...task, permissions: ["mcp-write"] }),
	);
	assert.equal(await reviewNightPlan(mock.ctx, [task]), null);
	assert.ok(mock.notifications.some((text) => text.includes("MCP writes are disabled")));
});
it("rejects malformed metadata from the JSON editor without crashing", async () => {
	const mock = reviewContext([["e"], [" ", "\r"]], JSON.stringify({ ...task, outputs: "not an array" }));
	const result = await reviewNightPlan(mock.ctx, [task]);
	assert.deepEqual(result?.[0].outputs, []);
	assert.ok(mock.notifications.some((text) => text.includes("invalid task")));
});
