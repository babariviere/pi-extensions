import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SANDBOX_REQUEST_EVENT } from "../sandbox/protocol.ts";
import nightMode from "./index.ts";
import { readActiveNightRun } from "./night-run.ts";

type Entry = { customType: string; data: unknown };
type Options = { unavailable?: boolean; setModel?: () => Promise<boolean>; idle?: () => boolean };

function harness(entries: Entry[], options: Options = {}) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
	let modelLookups = 0;
	const notifications: string[] = [];
	const messages: string[] = [];
	const registeredTools: string[] = [];
	const emissions: string[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		events: { on: () => () => {}, emit: (name: string) => emissions.push(name) },
		registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
		registerCommand: (_name: string, value: { handler: typeof command }) => {
			command = value.handler;
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		setModel: options.setModel ?? (async () => true),
		sendUserMessage: (message: string) => messages.push(message),
	} as unknown as ExtensionAPI;
	const ctx = {
		isIdle: options.idle ?? (() => true),
		sessionManager: { getEntries: () => entries, getSessionId: () => "direct-night" },
		modelRegistry: {
			find: () => {
				modelLookups++;
				return options.unavailable ? undefined : { provider: "test", id: "night" };
			},
		},
		newSession: () => {
			throw new Error("Direct execution must not replace the session");
		},
		ui: { notify: (text: string) => notifications.push(text), setStatus() {} },
	} as unknown as ExtensionContext;
	nightMode(pi);
	return {
		event: async (name: string) => {
			await handlers.get(name)?.({}, ctx);
		},
		command: (args: string) => command(args, ctx),
		lookups: () => modelLookups,
		notifications,
		messages,
		registeredTools,
		emissions,
	};
}

async function withProject(fn: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "night-schedule-"));
	const previousCwd = process.cwd();
	const keys = ["PI_CODING_AGENT_DIR", "PI_TODO_PATH", "XDG_CONFIG_HOME"] as const;
	const previous = keys.map((key) => process.env[key]);
	process.env.PI_CODING_AGENT_DIR = cwd;
	process.chdir(cwd);
	writeFileSync(join(cwd, "prompt.md"), "Inspect routine sources and delegate concrete work");
	writeFileSync(join(cwd, "instructions.md"), "Check documentation");
	writeFileSync(
		join(cwd, "settings.json"),
		JSON.stringify({
			nightMode: {
				orchestratorModel: "test/night",
				promptPath: join(cwd, "prompt.md"),
				instructionsPath: join(cwd, "instructions.md"),
				reportPathTemplate: join(cwd, "reports", "{datetime}.md"),
				archiveDir: "",
				todoPath: join(cwd, "todos"),
				sandboxRoot: "",
				wakeLock: "off",
			},
		}),
	);
	try {
		await fn(cwd);
	} finally {
		process.chdir(previousCwd);
		keys.forEach((key, i) => {
			if (previous[i] === undefined) delete process.env[key];
			else process.env[key] = previous[i];
		});
		rmSync(cwd, { recursive: true, force: true });
	}
}

function scheduled(at: number): Entry[] {
	return [{ customType: "night-mode:schedule", data: { status: "scheduled", at } }];
}

it("restores the original schedule without execution before its deadline", async (t) => {
	const at = new Date(2026, 7, 29, 21).getTime();
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: at - 1000 });
	await withProject(async (cwd) => {
		const entries = scheduled(at);
		const first = harness(entries);
		await first.event("session_start");
		assert.equal(first.lookups(), 0);
		assert.match(first.notifications[0], /scheduled for/);
		assert.equal(existsSync(join(cwd, "reports")), false);
		assert.equal(existsSync(join(cwd, "todos")), false);
		assert.equal(readActiveNightRun(), undefined);
		await first.event("session_shutdown");
		const restored = harness(entries);
		try {
			await restored.event("session_start");
			t.mock.timers.tick(999);
			assert.equal(restored.lookups(), 0);
			t.mock.timers.tick(1);
			// Flush the asynchronous model selection and disabled-clone preparation.
			for (let i = 0; i < 8; i++) await Promise.resolve();
			assert.equal(restored.lookups(), 1);
			assert.equal(restored.messages.length, 1);
			assert.ok(readActiveNightRun());
			assert.equal((entries.at(-1)?.data as { status: string }).status, "started");
		} finally {
			await restored.event("session_shutdown");
		}
	});
});

it("starts an overdue restored schedule without rolling it forward", async (t) => {
	const at = new Date(2026, 7, 29, 21).getTime();
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: at + 12 * 3600000 });
	await withProject(async () => {
		const run = harness(scheduled(at));
		try {
			await run.event("session_start");
			assert.equal(run.lookups(), 1);
			assert.equal(run.messages.length, 1);
		} finally {
			await run.event("session_shutdown");
		}
	});
});

it("off cancels the timer and persists cancellation across reload", async (t) => {
	const at = new Date(2026, 7, 29, 21).getTime();
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: at - 1000 });
	await withProject(async () => {
		const entries = scheduled(at);
		const run = harness(entries);
		await run.event("session_start");
		await run.command("off");
		t.mock.timers.tick(1000);
		assert.equal(run.lookups(), 0);
		await run.event("session_shutdown");
		const restored = harness(entries);
		try {
			await restored.event("session_start");
			assert.equal(restored.lookups(), 0);
		} finally {
			await restored.event("session_shutdown");
		}
	});
});

for (const command of ["start", "start-now"]) {
	it(`${command} executes directly with safety policy and an initially empty ledger`, async () => {
		await withProject(async (cwd) => {
			const run = harness([]);
			try {
				await run.command(command);
				assert.deepEqual(run.registeredTools, [], "no planning or replacement action tool");
				assert.equal(run.messages.length, 1);
				assert.match(run.messages[0], /Discover tonight's work/);
				assert.match(run.messages[0], /run:\d{4}-\d{2}-\d{2}-\d{4}/);
				assert.match(run.messages[0], /Check documentation/);
				assert.doesNotMatch(run.messages[0], /night_plan|approved ledger/);
				assert.equal(readActiveNightRun()?.sandbox?.mode, "workspace-write");
				assert.equal(readActiveNightRun()?.mcp?.readOnly, true);
				assert.ok(run.emissions.includes(SANDBOX_REQUEST_EVENT));
				assert.deepEqual(readdirSync(join(cwd, "todos")), []);
				await run.command(command);
				assert.equal(run.messages.length, 1, "an active run is not duplicated");
			} finally {
				await run.event("session_shutdown");
			}
		});
	});
}

it("schedule persists a direct start at 21:00 without a planning session", async (t) => {
	const at = new Date(2026, 7, 29, 21).getTime();
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: at - 1000 });
	await withProject(async () => {
		const entries: Entry[] = [];
		const run = harness(entries);
		try {
			await run.command("schedule");
			assert.deepEqual(entries, scheduled(at));
			assert.equal(run.lookups(), 0);
			assert.equal(run.messages.length, 0);
			await run.command("start-now");
			assert.equal(run.messages.length, 1, "start-now overrides a pending schedule");
			t.mock.timers.tick(1000);
			assert.equal(run.messages.length, 1);
		} finally {
			await run.event("session_shutdown");
		}
	});
});

it("failed startup never marks the schedule started or retries on ticks", async (t) => {
	const at = new Date(2026, 7, 29, 21).getTime();
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: at });
	await withProject(async (cwd) => {
		const entries = scheduled(at);
		const run = harness(entries, { unavailable: true });
		try {
			await run.event("session_start");
			assert.equal(run.lookups(), 1);
			assert.equal(run.messages.length, 0);
			assert.deepEqual(entries, scheduled(at));
			t.mock.timers.tick(60_000);
			assert.equal(run.lookups(), 1);
			assert.equal(existsSync(join(cwd, "reports")), false);
		} finally {
			await run.event("session_shutdown");
		}
	});
});

for (const cancel of ["off", "session_shutdown"]) {
	it(`${cancel} during deferred model selection cancels startup`, async () => {
		await withProject(async (cwd) => {
			let release!: (value: boolean) => void;
			const deferred = new Promise<boolean>((resolve) => {
				release = resolve;
			});
			const run = harness([], { setModel: () => deferred });
			const start = run.command("start");
			assert.equal(run.lookups(), 1);
			if (cancel === "off") await run.command("off");
			else await run.event("session_shutdown");
			release(true);
			await start;
			assert.equal(run.messages.length, 0);
			assert.equal(readActiveNightRun(), undefined);
			assert.equal(run.emissions.includes(SANDBOX_REQUEST_EVENT), false);
			assert.equal(existsSync(join(cwd, "reports")), false);
			await run.event("session_shutdown");
		});
	});
}
