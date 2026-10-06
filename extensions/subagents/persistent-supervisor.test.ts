import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { writeActiveNightRun, clearActiveNightRun, type ActiveNightRun } from "../night-mode/night-run.ts";
import type { WorkerCallbacks, WorkerConnection, WorkerFactory } from "./conversation-backend.ts";
import {
	approvedNightForName,
	acquireDurableSupervisor,
	closeDurableSupervisor,
	durableDirectory,
	DurableSupervisor,
	type SubagentReport,
} from "./durable-supervisor.ts";
import { openDurableStorage } from "./durable-storage.ts";
import type { SessionRef } from "./session-ref.ts";
import type { WorkerSpec, WorkerStatus } from "./worker-protocol.ts";

const policy = { model: "test/cheap", parentProvider: "test", timeoutMs: 60_000 };
async function until(check: () => boolean | Promise<boolean>) {
	for (let n = 0; n < 300; n++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("Timed out waiting for journal state");
}
function workers() {
	type Kernel = {
		spec: WorkerSpec;
		callbacks: WorkerCallbacks;
		connection: WorkerConnection;
		status: WorkerStatus;
		inputs: Array<{ id: string; message: string; followUp: boolean }>;
		stops: string[];
		pauses: number;
		cancels: number;
	};
	const opened: Kernel[] = [];
	const persisted = new Map<string, WorkerStatus>();
	const factory: WorkerFactory = (spec, callbacks) => {
		const status = structuredClone(persisted.get(spec.directory) ?? { conversationId: "8", working: false });
		if (spec.stopOnOpen) status.working = false;
		const kernel = { spec, callbacks, status, inputs: [], stops: [], pauses: 0, cancels: 0 } as unknown as Kernel;
		const save = () => {
			persisted.set(spec.directory, structuredClone(kernel.status));
			return structuredClone(kernel.status);
		};
		kernel.connection = {
			ready: Promise.resolve(save()),
			input: async (id, message, followUp) => {
				kernel.inputs.push({ id, message, followUp });
				kernel.status.working = true;
				return save();
			},
			status: async () => save(),
			stop: async (id) => {
				kernel.stops.push(id);
				kernel.status.working = false;
				return save();
			},
			pause: async () => {
				kernel.pauses++;
				save();
				callbacks.exit();
			},
			cancel: async () => {
				kernel.cancels++;
				save();
				callbacks.exit();
			},
		};
		opened.push(kernel);
		return kernel.connection;
	};
	const answer = (kernel: Kernel, inputId: string, id: string, text: string, status?: WorkerStatus) => {
		kernel.status = status ?? { conversationId: "8", working: false, lastAnswer: { id, text } };
		persisted.set(kernel.spec.directory, structuredClone(kernel.status));
		kernel.callbacks.answer(inputId, { ok: true, answer: { id, text } }, structuredClone(kernel.status));
	};
	return { factory, opened, answer };
}
async function fixture(
	run: (ref: SessionRef, fake: ReturnType<typeof workers>, owner: DurableSupervisor) => Promise<void>,
) {
	const directory = await mkdtemp(join(tmpdir(), "named-supervisor-"));
	const ref: SessionRef = { cwd: directory, sessionId: "parent", sessionFile: join(directory, "parent.jsonl") };
	const fake = workers();
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const owner = await DurableSupervisor.open(ref, fake.factory);
	try {
		await run(ref, fake, owner);
	} finally {
		await owner.close();
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
}

test("named admissions are journaled before launch, deduplicated, and retain pinned host policy", async () => {
	await fixture(async (_ref, fake, owner) => {
		const started = await owner.spawn("__proto__", "first", "one", policy);
		assert.equal(started.state, "working");
		assert.equal(started.conversationId, "8");
		assert.equal(fake.opened.length, 1);
		const kernel = fake.opened[0]!;
		assert.equal(kernel.spec.request.overrides?.model, "test/cheap");
		assert.doesNotMatch(kernel.spec.directory, /__proto__.*\.md$/);
		assert.deepEqual(kernel.inputs, [{ id: "one", message: "first", followUp: false }]);
		assert.deepEqual(await owner.spawn("__proto__", "first", "one", policy), started);
		await assert.rejects(owner.spawn("__proto__", "new", "two", policy), /already exists/);
		await owner.send("__proto__", "steer", false, "two");
		await owner.send("__proto__", "queued", true, "three");
		await owner.send("__proto__", "queued", true, "three");
		assert.equal(kernel.inputs.length, 3);
		assert.equal(kernel.inputs[1]!.followUp, false);
		assert.equal(kernel.inputs[2]!.followUp, true);
		await assert.rejects(owner.send("__proto__", "different", true, "three"), /different content/);
	});
});

test("spawn cwd is pinned across sends, stop/resume and supervisor recovery", async () => {
	await fixture(async (ref, fake, owner) => {
		const target = join(ref.cwd, "other");
		await mkdir(target);
		await owner.spawn("other", "first", "one", policy, "other");
		const kernel = fake.opened[0]!;
		assert.equal(kernel.spec.context.cwd, await realpath(target));
		assert.equal(kernel.spec.context.projectTrusted, false);
		assert.equal(kernel.spec.request.cwd, undefined, "caller placement must not masquerade as a night workspace");
		assert.equal(kernel.spec.context.sessionFile, ref.sessionFile);
		await owner.spawn("other", "first", "one", policy, target);
		await assert.rejects(owner.spawn("other", "first", "one", policy, "."), /different cwd/);
		await owner.send("other", "steer", false, "two");
		await owner.stop("other");
		await owner.send("other", "resume", false, "three");
		await owner.close({ preserveRuns: true });
		const reopened = await DurableSupervisor.open(ref, fake.factory);
		try {
			await until(() => fake.opened.length === 2 && fake.opened[1]!.inputs.length === 1);
			assert.equal(fake.opened[1]!.spec.context.cwd, await realpath(target));
			assert.equal(fake.opened[1]!.spec.context.projectTrusted, false);
			await reopened.send("other", "follow-up", true, "four");
			assert.equal(fake.opened[1]!.inputs.at(-1)?.id, "four");
		} finally {
			await reopened.close();
		}
	});
});

test("invalid directories fail before admission or worker launch", async () => {
	await fixture(async (_ref, fake, owner) => {
		await assert.rejects(owner.spawn("missing", "work", "one", policy, "missing"), /existing directory/);
		assert.deepEqual(owner.list(), []);
		assert.equal(fake.opened.length, 0);
	});
});

test("coalesced and late Reporter receipts never regress lastAnswer or duplicate notifications", async () => {
	await fixture(async (_ref, fake, owner) => {
		await owner.spawn("research", "one", "one", policy);
		await owner.send("research", "two", false, "two");
		await owner.send("research", "three", true, "three");
		const reports: SubagentReport[] = [];
		let idle = false;
		owner.setSink(
			(report) => reports.push(report),
			() => idle,
		);
		const kernel = fake.opened[0]!;
		fake.answer(kernel, "three", "20", "latest");
		fake.answer(kernel, "one", "10", "shared", {
			conversationId: "8",
			working: false,
			lastAnswer: { id: "20", text: "latest" },
		});
		fake.answer(kernel, "two", "10", "shared");
		await until(() => owner.list()[0]?.state === "idle");
		assert.deepEqual((await owner.status("research")).lastAnswer, { id: "20", text: "latest" });
		assert.equal("lastAnswer" in owner.list()[0]!, false);
		assert.equal(reports.length, 0);
		idle = true;
		await Promise.all([owner.flushReports(), owner.flushReports()]);
		assert.equal(reports.length, 1);
		assert.equal(reports[0]!.answerId, "10", "only the unobserved shared answer should notify");
		fake.answer(kernel, "one", "10", "shared");
		await owner.flushReports();
		assert.equal(reports.length, 1);
		await owner.status("research");
		await owner.status("research");
		assert.equal(reports.length, 1, "status keeps the answer and does not resend it");
	});
});

test("answer identities and notification receipts are scoped to each child", async () => {
	await fixture(async (_ref, fake, owner) => {
		const reports: SubagentReport[] = [];
		owner.setSink((report) => reports.push(report));
		await owner.spawn("a", "a", "a", policy);
		await owner.spawn("b", "b", "b", policy);
		fake.answer(fake.opened[0]!, "a", "10", "answer a");
		fake.answer(fake.opened[1]!, "b", "10", "answer b");
		await until(() => reports.length === 2);
		assert.deepEqual(reports.map((r) => r.name).sort(), ["a", "b"]);
	});
});

test("stop withdraws active and queued inputs, ignores stale receipts, then permits send", async () => {
	await fixture(async (_ref, fake, owner) => {
		await owner.spawn("review", "first", "one", policy);
		await owner.send("review", "later", true, "two");
		const kernel = fake.opened[0]!;
		assert.equal((await owner.stop("review")).state, "idle");
		assert.equal(kernel.stops.length, 1);
		const reports: SubagentReport[] = [];
		owner.setSink((report) => reports.push(report));
		fake.answer(kernel, "one", "10", "stale");
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(reports.length, 0);
		assert.equal(owner.list()[0]!.state, "idle");
		await owner.send("review", "new", false, "three");
		assert.equal(fake.opened.length, 1);
		fake.answer(kernel, "three", "20", "fresh");
		await until(() => reports.length === 1);
		assert.equal((await owner.status("review")).lastAnswer?.text, "fresh");
	});
});

test("quit preserves pending work and original lifetime; reopen reuses stable input IDs and receipts", async () => {
	await fixture(async (ref, fake, owner) => {
		await owner.spawn("persist", "remember", "one", policy);
		const first = fake.opened[0]!;
		const deadline = first.spec.context.deadlineAt;
		await owner.close({ preserveRuns: true });
		assert.equal(first.pauses, 1);
		assert.equal(first.cancels, 0);
		const reopened = await DurableSupervisor.open(ref, fake.factory);
		try {
			await until(() => fake.opened.length === 2 && fake.opened[1]!.inputs.length === 1);
			assert.equal(fake.opened[1]!.spec.context.deadlineAt, deadline);
			assert.equal(fake.opened[1]!.inputs[0]!.id, "one");
			const reports: SubagentReport[] = [];
			reopened.setSink((report) => reports.push(report));
			fake.answer(fake.opened[1]!, "one", "10", "retained");
			await until(() => reports.length === 1);
			await reopened.close({ preserveRuns: true });
			const third = await DurableSupervisor.open(ref, fake.factory);
			try {
				third.setSink((report) => reports.push(report));
				assert.equal((await third.status("persist")).lastAnswer?.text, "retained");
				await third.flushReports();
				assert.equal(reports.length, 1);
				await third.send("persist", "again", false, "two");
				assert.equal(fake.opened.at(-1)!.spec.request.overrides?.model, "test/cheap");
			} finally {
				await third.close();
			}
		} finally {
			await reopened.close();
		}
	});
});

test("expired cycle stops before recovered inputs are redelivered and a later send starts a new lifetime", async () => {
	await fixture(async (ref, fake, owner) => {
		await owner.spawn("expiry", "first", "one", { ...policy, timeoutMs: 50 });
		await owner.close({ preserveRuns: true });
		await new Promise((resolve) => setTimeout(resolve, 70));
		const reopened = await DurableSupervisor.open(ref, fake.factory);
		try {
			await until(() => reopened.list()[0]?.state === "idle");
			const restored = fake.opened[1]!;
			assert.equal(restored.spec.stopOnOpen, true);
			assert.equal(restored.inputs.length, 0);
			assert.equal(restored.stops.length, 1);
			assert.match(reopened.list()[0]!.error ?? "", /lifetime expired/);
			await reopened.send("expiry", "second", false, "two");
			assert.equal(restored.inputs.at(-1)?.id, "two");
			assert.equal(reopened.list()[0]!.error, undefined);
		} finally {
			await reopened.close();
		}
	});
});

test("normal cancellation retains stop intent for parked/crashed children before a future send", async () => {
	await fixture(async (ref, fake, owner) => {
		await owner.spawn("cancel", "first", "one", policy);
		await owner.close();
		assert.equal(fake.opened[0]!.cancels, 1);
		const reopened = await DurableSupervisor.open(ref, fake.factory);
		try {
			await until(() => fake.opened.length === 2 && fake.opened[1]!.stops.length > 0);
			assert.equal(fake.opened[1]!.spec.stopOnOpen, true);
			assert.equal(reopened.list()[0]!.state, "idle");
			await reopened.send("cancel", "second", false, "two");
			assert.equal(fake.opened[1]!.inputs.at(-1)?.id, "two");
		} finally {
			await reopened.close();
		}
	});
});

test("same-process reload shares a supervisor/lease and safely retires old architecture owners", async () => {
	const directory = await mkdtemp(join(tmpdir(), "named-owner-upgrade-"));
	const ref = { cwd: directory, sessionId: "parent", sessionFile: join(directory, "parent.jsonl") };
	const fake = workers();
	const symbol = Symbol.for("babariviere.pi-extensions.durable-supervisors.v2");
	const state = globalThis as unknown as Record<symbol, Map<string, { entry: Promise<unknown> }>>;
	const map = (state[symbol] ??= new Map());
	const storage = await openDurableStorage(durableDirectory(ref));
	let retired = false;
	map.set(durableDirectory(ref), {
		entry: Promise.resolve({
			close: async () => {
				retired = true;
				await storage.storage.close(BACKGROUND_CONTEXT);
				storage.release();
			},
		}),
	});
	try {
		const first = await acquireDurableSupervisor(ref, fake.factory);
		assert.equal(retired, true);
		first.suspend();
		const second = await acquireDurableSupervisor(ref, fake.factory);
		assert.equal(first, second);
		await assert.rejects(openDurableStorage(durableDirectory(ref)), /already has an owner/);
		await closeDurableSupervisor(ref);
		const third = await acquireDurableSupervisor(ref, fake.factory);
		assert.notEqual(first, third);
	} finally {
		await closeDurableSupervisor(ref);
		map.delete(durableDirectory(ref));
		storage.release();
		await rm(directory, { recursive: true, force: true });
	}
});

test("closing wins over not-yet-started admissions without launching a child", async () => {
	await fixture(async (_ref, fake, owner) => {
		const admission = owner.spawn("race", "work", "one", policy);
		const rejected = assert.rejects(admission, /shutting down|closed/);
		await owner.close();
		await rejected;
		assert.equal(fake.opened.length, 0);
	});
});

test("night planning inherits read-only protection while execution requires an approved TODO name", () => {
	const ref = { cwd: "/repo", sessionId: "parent" };
	const base: ActiveNightRun = {
		startedAt: 1,
		reportPath: "/report",
		maxPullRequests: 1,
		sessionId: "parent",
		sandbox: { mode: "read-only", allowWrite: [], denyRead: [] },
		mcp: { readOnly: true },
	};
	assert.deepEqual(approvedNightForName("research", ref, base), base);
	assert.throws(
		() => approvedNightForName("research", ref, { ...base, phase: "planning", sandbox: { mode: "off" } }),
		/read-only/,
	);
	assert.throws(() => approvedNightForName("research", ref, { ...base, phase: "execution" }), /approved ledger/);
	assert.throws(() => approvedNightForName("TODO-bad", ref, { ...base, approvedTaskIds: ["abc"] }), /approved ledger/);
	assert.equal(approvedNightForName("TODO-abc", ref, { ...base, approvedTaskIds: ["abc"] })?.startedAt, 1);
	assert.equal(approvedNightForName("research", { ...ref, sessionId: "other" }, base), undefined);
});

test("failed notification sinks consume one durable receipt without losing named status", async () => {
	await fixture(async (ref, fake, owner) => {
		await owner.spawn("receipt", "work", "one", policy);
		let attempts = 0;
		let errors = 0;
		owner.setErrorHandler(() => errors++);
		owner.setSink(() => {
			attempts++;
			throw new Error("parent notification failed");
		});
		fake.answer(fake.opened[0]!, "one", "10", "durable answer");
		await until(() => attempts === 1 && errors === 1);
		await owner.flushReports();
		assert.equal(attempts, 1);
		await owner.close({ preserveRuns: true });
		const reopened = await DurableSupervisor.open(ref, fake.factory);
		try {
			reopened.setSink(() => attempts++);
			assert.equal((await reopened.status("receipt")).lastAnswer?.text, "durable answer");
			await reopened.flushReports();
			assert.equal(attempts, 1);
		} finally {
			await reopened.close();
		}
	});
});

test("reload during notification receipt commit cannot deliver through a stale sink or resend", async () => {
	await fixture(async (_ref, fake, owner) => {
		await owner.spawn("cutover", "work", "one", policy);
		let idle = false;
		let old = 0;
		let replacement = 0;
		owner.setSink(
			() => old++,
			() => idle,
		);
		fake.answer(fake.opened[0]!, "one", "10", "retained");
		await until(() => owner.list()[0]?.state === "idle");
		let receipt = true;
		const unsubscribe = owner.subscribe(() => {
			if (receipt) {
				receipt = false;
				owner.suspend();
			}
		});
		idle = true;
		await owner.flushReports();
		unsubscribe();
		owner.setSink(() => replacement++);
		await owner.flushReports();
		assert.equal(old, 0);
		assert.equal(replacement, 0);
		assert.equal((await owner.status("cutover")).lastAnswer?.text, "retained");
	});
});

test("a parked or exited idle worker reopens the same conversation on a non-destructive status read", async () => {
	await fixture(async (_ref, fake, owner) => {
		await owner.spawn("park", "work", "one", policy);
		fake.answer(fake.opened[0]!, "one", "10", "retained");
		await until(() => owner.list()[0]?.state === "idle");
		fake.opened[0]!.callbacks.exit();
		await new Promise((resolve) => setTimeout(resolve, 10));
		const recovered = await owner.status("park");
		assert.equal(fake.opened.length, 2);
		assert.equal(fake.opened[1]!.inputs.length, 0);
		assert.equal(recovered.conversationId, "8");
		assert.equal(recovered.lastAnswer?.text, "retained");
	});
});

test("unacknowledged stop keeps durable intent and a later send aborts before admitting new input", async () => {
	await fixture(async (_ref, fake, owner) => {
		await owner.spawn("stop-failure", "work", "one", policy);
		fake.opened[0]!.connection.stop = async () => {
			throw new Error("stop not committed");
		};
		await assert.rejects(owner.stop("stop-failure"), /stop not committed/);
		assert.equal(fake.opened[0]!.cancels, 1);
		await owner.send("stop-failure", "next", false, "two");
		assert.equal(fake.opened[1]!.spec.stopOnOpen, true);
		assert.equal(fake.opened[1]!.stops.length, 1);
		assert.deepEqual(
			fake.opened[1]!.inputs.map((item) => item.id),
			["two"],
		);
	});
});

test("night binding pins ledger scope and rejects pre-night, ended and replaced policies on send", async () => {
	await fixture(async (ref, fake, owner) => {
		await owner.spawn("TODO-abc", "before night", "before", policy);
		const run: ActiveNightRun = {
			phase: "execution",
			startedAt: 1,
			sessionId: ref.sessionId,
			reportPath: "/report",
			maxPullRequests: 1,
			approvedTaskIds: ["abc", "def"],
			ledgerDir: join(ref.cwd, "ledger"),
			mcp: { readOnly: true },
		};
		await mkdir(run.ledgerDir!);
		const scope =
			JSON.stringify({ id: "def", title: "Read CI", tags: ["night", "approved"], status: "open" }) +
			"\n\n## Goal\nRead CI only.\nApproved operations: read-only\n";
		await writeFile(join(run.ledgerDir!, "def.md"), scope);
		writeActiveNightRun(run);
		try {
			await assert.rejects(owner.spawn("TODO-def", "work", "cwd", policy, "."), /host-controlled/);
			await assert.rejects(
				owner.send("TODO-abc", "cannot reuse pre-night", false, "denied"),
				/different night approval/,
			);
			await owner.spawn("TODO-def", "perform approved scope", "approved", policy);
			const kernel = fake.opened.at(-1)!;
			assert.equal(kernel.spec.context.nightTask, scope);
			await writeFile(join(run.ledgerDir!, "def.md"), scope + "Caller tried to change ledger later.");
			await owner.send("TODO-def", "follow-up within scope", true, "allowed");
			assert.equal(
				kernel.spec.context.nightTask,
				scope,
				"host scope stays pinned, not reread from a mutable ledger",
			);
			clearActiveNightRun();
			await assert.rejects(owner.send("TODO-def", "ended", false, "ended"), /different night approval/);
			writeActiveNightRun({ ...run, startedAt: 2 });
			await assert.rejects(owner.send("TODO-def", "replaced", false, "replaced"), /different night approval/);
			assert.equal(kernel.inputs.length, 2);
			await owner.stop("TODO-def");
		} finally {
			clearActiveNightRun();
		}
	});
});

test("planning explorers inherit read-only policies and are retired at a cancelling host boundary", async () => {
	await fixture(async (ref, fake, owner) => {
		const run: ActiveNightRun = {
			phase: "planning",
			startedAt: 1,
			sessionId: ref.sessionId,
			reportPath: "/report",
			maxPullRequests: 1,
			sandbox: { mode: "read-only", allowWrite: [], denyRead: [] },
			mcp: { readOnly: true },
		};
		writeActiveNightRun(run);
		try {
			await assert.rejects(owner.spawn("explorer", "read only", "cwd", policy, "."), /host-controlled/);
			assert.equal(fake.opened.length, 0);
			await owner.spawn("explorer", "read only", "one", policy);
			assert.deepEqual(fake.opened[0]!.spec.context.nightRun, run);
			await owner.close();
			const reopened = await DurableSupervisor.open(ref, fake.factory);
			try {
				await assert.rejects(reopened.send("explorer", "retired", false, "two"), /different night approval/);
				assert.equal((await reopened.status("explorer")).state, "idle");
				assert.equal(fake.opened.length, 1, "retired kernel must not reopen in a released workspace");
			} finally {
				await reopened.close();
			}
		} finally {
			clearActiveNightRun();
		}
	});
});

test("named status acknowledges its exact pending answer and keeps repeated reads available", async () => {
	await fixture(async (_ref, fake, owner) => {
		await owner.spawn("observed", "work", "one", policy);
		const reports: SubagentReport[] = [];
		let idle = false;
		owner.setSink(
			(report) => reports.push(report),
			() => idle,
		);
		fake.answer(fake.opened[0]!, "one", "10", "seen");
		await until(() => owner.list()[0]?.state === "idle");
		assert.equal((await owner.status("observed")).lastAnswer?.text, "seen");
		assert.equal((await owner.status("observed")).lastAnswer?.text, "seen");
		idle = true;
		await owner.flushReports();
		assert.equal(reports.length, 0);
		await owner.send("observed", "new work", false, "two");
		fake.answer(fake.opened[0]!, "two", "20", "unread");
		await until(() => reports.length === 1);
		assert.equal(reports[0]!.answerId, "20", "a later unread answer must still notify");
	});
});

test("observing before a Reporter receipt survives restart and suppresses its late notification", async () => {
	await fixture(async (ref, fake, owner) => {
		await owner.spawn("late-receipt", "work", "one", policy);
		const first = fake.opened[0]!;
		first.status = { conversationId: "8", working: false, lastAnswer: { id: "10", text: "canonical answer" } };
		assert.equal((await owner.status("late-receipt")).lastAnswer?.id, "10");
		assert.equal(owner.list()[0]!.state, "working", "the parent has not received the Reporter yet");
		await owner.close({ preserveRuns: true });
		const reopened = await DurableSupervisor.open(ref, fake.factory);
		try {
			const reports: SubagentReport[] = [];
			reopened.setSink((report) => reports.push(report));
			await until(() => fake.opened.length === 2 && fake.opened[1]!.inputs.length === 1);
			fake.answer(fake.opened[1]!, "one", "10", "canonical answer");
			await until(() => reopened.list()[0]?.state === "idle");
			await reopened.flushReports();
			assert.equal(reports.length, 0);
			assert.equal((await reopened.status("late-receipt")).lastAnswer?.text, "canonical answer");
		} finally {
			await reopened.close();
		}
	});
});

test("compact status acknowledges nothing and named status without an answer cannot suppress future work", async () => {
	await fixture(async (_ref, fake, owner) => {
		await owner.spawn("compact", "work", "one", policy);
		const reports: SubagentReport[] = [];
		let idle = false;
		owner.setSink(
			(report) => reports.push(report),
			() => idle,
		);
		assert.equal((await owner.status("compact")).lastAnswer, undefined);
		fake.answer(fake.opened[0]!, "one", "10", "unread");
		await until(() => owner.list()[0]?.state === "idle");
		assert.equal("lastAnswer" in owner.list()[0]!, false);
		idle = true;
		await owner.flushReports();
		assert.equal(reports.length, 1);
		assert.equal(reports[0]!.text, "unread");
	});
});

test("observations are per child and do not silence another child with the same local answer ID", async () => {
	await fixture(async (_ref, fake, owner) => {
		await owner.spawn("seen-child", "a", "a", policy);
		await owner.spawn("unseen-child", "b", "b", policy);
		const reports: SubagentReport[] = [];
		let idle = false;
		owner.setSink(
			(report) => reports.push(report),
			() => idle,
		);
		fake.answer(fake.opened[0]!, "a", "10", "seen");
		fake.answer(fake.opened[1]!, "b", "10", "unseen");
		await until(() => owner.list().every((status) => status.state === "idle"));
		await owner.status("seen-child");
		idle = true;
		await owner.flushReports();
		assert.deepEqual(
			reports.map((report) => report.name),
			["unseen-child"],
		);
	});
});

test("in-progress named status wins the notification race against a newly received answer", async () => {
	await fixture(async (_ref, fake, owner) => {
		await owner.spawn("status-race", "work", "one", policy);
		const kernel = fake.opened[0]!;
		const reports: SubagentReport[] = [];
		owner.setSink((report) => reports.push(report));
		let statusStarted = false;
		let resolveStatus!: (status: WorkerStatus) => void;
		kernel.connection.status = () => {
			statusStarted = true;
			return new Promise((resolve) => {
				resolveStatus = resolve;
			});
		};
		const read = owner.status("status-race");
		await until(() => statusStarted);
		fake.answer(kernel, "one", "10", "completed during read");
		await until(() => owner.list()[0]?.state === "idle");
		assert.equal(reports.length, 0, "notification waits behind the in-progress read");
		resolveStatus(kernel.status);
		assert.equal((await read).lastAnswer?.id, "10");
		await owner.flushReports();
		assert.equal(reports.length, 0);
	});
});

test("reading a previous answer does not acknowledge a later failure", async () => {
	await fixture(async (_ref, fake, owner) => {
		await owner.spawn("failure", "work", "one", policy);
		const kernel = fake.opened[0]!;
		const reports: SubagentReport[] = [];
		let idle = false;
		owner.setSink(
			(report) => reports.push(report),
			() => idle,
		);
		fake.answer(kernel, "one", "10", "previous answer");
		await until(() => owner.list()[0]?.state === "idle");
		await owner.status("failure");
		await owner.send("failure", "fails", false, "two");
		const error = "Codex error: Our servers are currently overloaded. Please try again later.";
		kernel.callbacks.answer("two", { ok: false, error }, kernel.status);
		await until(() => owner.list()[0]?.state === "idle");
		const status = await owner.status("failure");
		assert.equal(status.lastAnswer?.text, "previous answer");
		assert.equal(status.error, error);
		idle = true;
		await owner.flushReports();
		assert.equal(reports.length, 1);
		assert.equal(reports[0]!.error, error);
	});
});

for (const previousFormat of ["named-conversations-v1", "named-conversations-v2"]) {
	test(`compatible supervisor reload from ${previousFormat} adopts acknowledgements without cancelling pending work`, async () => {
		await fixture(async (ref, fake, owner) => {
			await owner.spawn("upgrade", "work", "one", policy);
			const first = fake.opened[0]!;
			first.status = { conversationId: "8", working: false, lastAnswer: { id: "10", text: "seen before reload" } };
			await owner.status("upgrade");
			Object.defineProperty(owner, "format", { value: previousFormat });
			const symbol = Symbol.for("babariviere.pi-extensions.durable-supervisors.v2");
			const state = globalThis as unknown as Record<symbol, Map<string, { entry: Promise<unknown> }>>;
			const map = (state[symbol] ??= new Map());
			map.set(durableDirectory(ref), { entry: Promise.resolve(owner) });
			try {
				const upgraded = await acquireDurableSupervisor(ref, fake.factory);
				assert.notEqual(upgraded, owner);
				assert.equal(upgraded.format, "named-conversations-v3");
				assert.equal(first.pauses, 1);
				assert.equal(first.cancels, 0);
				await until(() => fake.opened.length === 2 && fake.opened[1]!.inputs.length === 1);
				const reports: SubagentReport[] = [];
				upgraded.setSink((report) => reports.push(report));
				fake.answer(fake.opened[1]!, "one", "10", "seen before reload");
				await until(() => upgraded.list()[0]?.state === "idle");
				await upgraded.flushReports();
				assert.equal(reports.length, 0);
				assert.equal((await upgraded.status("upgrade")).lastAnswer?.text, "seen before reload");
				await upgraded.send("upgrade", "next", false, "two");
				assert.equal(fake.opened[1]!.inputs.at(-1)?.id, "two");
				await mkdir(join(ref.cwd, "selected"));
				await upgraded.spawn("selected", "work", "new", policy, "selected");
				assert.equal(fake.opened[2]!.spec.context.cwd, await realpath(join(ref.cwd, "selected")));
			} finally {
				await closeDurableSupervisor(ref);
				map.delete(durableDirectory(ref));
			}
		});
	});
}
