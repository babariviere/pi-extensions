import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { waitForClaudeUsage } from "./claude-limit.ts";
import type { UsageSnapshot } from "./protocol.ts";
import { REFRESH_INTERVAL_MS } from "./source.ts";

function harness(provider = "anthropic", oauth = true) {
	const controller = new AbortController();
	const statuses: Array<string | undefined> = [];
	const ctx = {
		model: { provider },
		signal: controller.signal,
		modelRegistry: { isUsingOAuth: () => oauth },
		hasUI: true,
		ui: {
			setStatus: (_key: string, status: string | undefined) => statuses.push(status),
			notify() {},
		},
	} as unknown as ExtensionContext;
	return { controller, ctx, statuses };
}

test("100% on either window holds the request until both windows have room", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const { controller, ctx, statuses } = harness();
	t.after(() => controller.abort());
	const fiveHour = { label: "5h", usedPercent: 100 };
	let snapshot: UsageSnapshot = {
		provider: "anthropic",
		windows: [fiveHour, { label: "Week", usedPercent: 100 }],
	};
	const request = waitForClaudeUsage(ctx, () => snapshot);
	assert.match(statuses[0] ?? "", /weekly limit reached/);

	snapshot = { provider: "anthropic", windows: [fiveHour] };
	t.mock.timers.tick(REFRESH_INTERVAL_MS);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.match(statuses[1] ?? "", /5h limit reached/);

	fiveHour.usedPercent = 99.9;
	t.mock.timers.tick(REFRESH_INTERVAL_MS);
	await request;
	assert.equal(statuses.at(-1), undefined);
});

test("a known reset lifts the pause without waiting for the next poll", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const { controller, ctx, statuses } = harness();
	t.after(() => controller.abort());
	const snapshot: UsageSnapshot = {
		provider: "anthropic",
		windows: [{ label: "Week", usedPercent: 100, resetsAt: new Date(Date.now() + 500).toISOString() }],
	};
	const request = waitForClaudeUsage(ctx, () => snapshot);
	assert.match(statuses[0] ?? "", /resets/);
	t.mock.timers.tick(500);
	await request;
	assert.equal(statuses.at(-1), undefined);
});

test("aborting ends the wait and clears the pause status", async () => {
	const { controller, ctx, statuses } = harness();
	const request = waitForClaudeUsage(ctx, () => ({
		provider: "anthropic",
		windows: [{ label: "5h", usedPercent: 100 }],
	}));
	assert.match(statuses[0] ?? "", /5h limit reached/);
	controller.abort();
	await request;
	assert.equal(statuses.at(-1), undefined);
});

test("other providers, API keys, missing usage and non-limit windows do not pause", async () => {
	const full: UsageSnapshot = { provider: "anthropic", windows: [{ label: "5h", usedPercent: 100 }] };
	const cases: Array<[ReturnType<typeof harness>, UsageSnapshot | undefined]> = [
		[harness("openai-codex"), full],
		[harness("anthropic", false), full],
		[harness(), undefined],
		[harness(), { ...full, provider: "openai" }],
		[
			harness(),
			{
				...full,
				windows: [
					{ label: "5h", usedPercent: 99.9 },
					{ label: "Extra", usedPercent: 100 },
				],
			},
		],
	];
	for (const [{ controller, ctx, statuses }, snapshot] of cases) {
		const request = waitForClaudeUsage(ctx, () => snapshot);
		try {
			assert.deepEqual(statuses, []);
		} finally {
			controller.abort();
			await request;
		}
	}
});
