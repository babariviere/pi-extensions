import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { openConversationWorker, type WorkerConnection } from "./conversation-backend.ts";
import { builtinAgent } from "./discovery.ts";
import type { WorkerAnswer, WorkerSpec, WorkerStatus } from "./worker-protocol.ts";

const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

async function waitFor(check: () => Promise<boolean>, description: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!(await check())) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
		await delay();
	}
}

async function withOfflineWorkers(
	body: (fixture: {
		directory: string;
		spec: WorkerSpec;
		open(spec?: WorkerSpec): {
			worker: WorkerConnection;
			answer(id: string): Promise<{ result: WorkerAnswer; status: WorkerStatus }>;
		};
	}) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "persistent-native-worker-"));
	const previous = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		offline: process.env.PI_OFFLINE,
		configHome: process.env.XDG_CONFIG_HOME,
	};
	const workers = new Set<WorkerConnection>();
	process.env.PI_CODING_AGENT_DIR = directory;
	process.env.PI_OFFLINE = "1";
	process.env.XDG_CONFIG_HOME = join(directory, "config-source");
	try {
		await mkdir(process.env.XDG_CONFIG_HOME);
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({
				extensions: [fileURLToPath(new URL("./fixtures/offline-native.ts", import.meta.url))],
				defaultProvider: "faux",
				defaultModel: "faux-1",
				defaultTools: ["+codemode"],
				cacheWarming: "off",
			}),
		);
		const spec: WorkerSpec = {
			name: "offline",
			request: {
				agent: builtinAgent(),
				task: "not an admitted input",
				index: 0,
				overrides: { model: "faux/faux-1" },
			},
			context: {
				cwd: directory,
				sessionId: "parent",
				sessionFile: join(directory, "parent.jsonl"),
				runId: "offline",
				projectTrusted: false,
				timeoutMs: 20_000,
			},
			directory: join(directory, "conversation"),
		};
		await body({
			directory,
			spec,
			open: (launch = spec) => {
				const answers = new Map<string, { result: WorkerAnswer; status: WorkerStatus }>();
				let exited = false;
				let failure: Error | undefined;
				const worker = openConversationWorker(launch, {
					answer: (id, result, status) => answers.set(id, { result, status }),
					exit: (error) => {
						exited = true;
						failure = error;
					},
				});
				workers.add(worker);
				return {
					worker,
					answer: async (id) => {
						await waitFor(async () => {
							if (answers.has(id)) return true;
							if (exited) throw failure ?? new Error(`Worker closed before answer ${id}`);
							return false;
						}, `answer ${id}`);
						return answers.get(id)!;
					},
				};
			},
		});
	} finally {
		// pause/cancel join private process-group teardown, including assertion failures.
		try {
			await Promise.all([...workers].map((worker) => worker.cancel()));
		} finally {
			if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
			if (previous.offline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previous.offline;
			if (previous.configHome === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previous.configHome;
			await rm(directory, { recursive: true, force: true });
		}
	}
}

async function marker(directory: string, name: string): Promise<void> {
	await waitFor(async () => {
		try {
			await access(join(directory, name));
			return true;
		} catch {
			return false;
		}
	}, name);
}

async function noMarkdown(directory: string): Promise<void> {
	assert.deepEqual(
		(await readdir(directory, { recursive: true })).filter((file) => file.endsWith(".md")),
		[],
	);
}

test("persistent worker admits explicit input with real native codemode, structured results and policy hooks", async () => {
	await withOfflineWorkers(async ({ directory, open }) => {
		const first = open();
		const ready = await first.worker.ready;
		assert.ok(ready.conversationId);
		assert.equal(ready.working, false);
		assert.equal(ready.lastAnswer, undefined);
		await assert.rejects(access(join(directory, "input-count")));
		const accepted = await first.worker.input("native", "exercise native tools", false);
		assert.equal(accepted.conversationId, ready.conversationId);
		const { result } = await first.answer("native");
		assert.equal(result.ok, true, result.error ?? "Worker failed");
		assert.ok(result.answer?.id);
		assert.match(result.answer!.text, /native hook/);
		assert.match(result.answer!.text, /echoed/);
		assert.equal("outputPath" in result, false);
		const status = await first.worker.status();
		assert.equal(status.working, false);
		assert.deepEqual(status.lastAnswer, result.answer);
		const generations = await readFile(join(directory, "generation-count"), "utf8");
		await first.worker.pause();
		const reopened = open();
		assert.deepEqual(await reopened.worker.ready, status);
		await reopened.worker.input("native", "exercise native tools", false);
		assert.deepEqual((await reopened.answer("native")).result, result);
		assert.equal(await readFile(join(directory, "generation-count"), "utf8"), generations);
		assert.equal(await readFile(join(directory, "input-count"), "utf8"), "1");
		await reopened.worker.cancel();
		await noMarkdown(directory);
	});
});

for (const [task, checkpoint] of [
	["recover model", "model-started"],
	["recover unsafe", "effects"],
	["recover store", "store-saved"],
	["recover forced", "model-started"],
]) {
	test(`worker pause/reopen ${task} retains input without replaying native effects`, async () => {
		await withOfflineWorkers(async ({ directory, open }) => {
			const first = open();
			const ready = await first.worker.ready;
			await first.worker.input("recover", task, false);
			await marker(directory, checkpoint);
			assert.equal((await first.worker.status()).working, true);
			await first.worker.pause();
			const reopened = open();
			assert.equal((await reopened.worker.ready).conversationId, ready.conversationId);
			// Duplicate admission races reattached Reporters, but never runs native input hooks twice.
			await reopened.worker.input("recover", task, false);
			const { result } = await reopened.answer("recover");
			assert.equal(result.ok, true, result.error ?? "Worker failed");
			if (task === "recover model" || task === "recover forced") assert.match(result.answer!.text, /user inputs: 1/);
			else if (task === "recover store") assert.match(result.answer!.text, /persisted-value/);
			else {
				assert.match(result.answer!.text, /not replayed/);
				assert.match(result.answer!.text, /interrupt/i);
				assert.equal(await readFile(join(directory, "effects"), "utf8"), "1");
			}
			assert.equal(await readFile(join(directory, "input-count"), "utf8"), "1");
			if (task === "recover forced") assert.equal(await readFile(join(directory, "prompt-starts"), "utf8"), "1");
			assert.equal((await reopened.worker.status()).working, false);
			await reopened.worker.cancel();
			await noMarkdown(directory);
		});
	});
}

test("native input transformation runs once per receipt, including reopen", async () => {
	await withOfflineWorkers(async ({ directory, open }) => {
		const first = open();
		await first.worker.ready;
		await first.worker.input("once", "once input", false);
		const { result } = await first.answer("once");
		assert.equal(result.ok, true, result.error ?? "Worker failed");
		assert.match(result.answer!.text, /transformed input, user inputs: 1/);
		await first.worker.pause();
		const reopened = open();
		await reopened.worker.ready;
		await reopened.worker.input("once", "once input", false);
		assert.deepEqual((await reopened.answer("once")).result, result);
		assert.equal(await readFile(join(directory, "input-count"), "utf8"), "1");
	});
});

test("a named conversation remembers earlier inputs and answers across worker replacement", async () => {
	await withOfflineWorkers(async ({ directory, spec, open }) => {
		const named = { ...spec, name: "researcher" };
		const first = open(named);
		const ready = await first.worker.ready;
		await first.worker.input("remember", "memory remember cobalt-739", false);
		const initial = (await first.answer("remember")).result;
		assert.equal(initial.ok, true, initial.error ?? "Worker failed");
		assert.equal(initial.answer?.text, "Memory saved: cobalt-739");
		await first.worker.pause();
		const reopened = open(named);
		assert.equal((await reopened.worker.ready).conversationId, ready.conversationId);
		await reopened.worker.input("recall", "memory recall", true);
		const recalled = (await reopened.answer("recall")).result;
		assert.equal(recalled.ok, true, recalled.error ?? "Worker failed");
		assert.equal(
			recalled.answer?.text,
			"Memory recalled: cobalt-739; prior answer: Memory saved: cobalt-739; user inputs: 2",
		);
		assert.notEqual(recalled.answer?.id, initial.answer?.id);
		assert.deepEqual((await reopened.worker.status()).lastAnswer, recalled.answer);
		await reopened.worker.cancel();
		await noMarkdown(directory);
	});
});

test("stop aborts busy work and queued follow-up, but leaves the conversation reusable", async () => {
	await withOfflineWorkers(async ({ directory, open }) => {
		const first = open();
		const ready = await first.worker.ready;
		await first.worker.input("busy", "recover unsafe", false);
		await marker(directory, "effects");
		await first.worker.input("queued", "memory remember cobalt-739", true);
		assert.equal((await first.worker.status()).working, true);
		const stopped = await first.worker.stop("stop");
		assert.equal(stopped.conversationId, ready.conversationId);
		assert.equal(stopped.working, false);
		for (const id of ["busy", "queued"])
			assert.deepEqual((await first.answer(id)).result, { ok: false, aborted: true });
		await first.worker.input("later", "memory remember cobalt-739", false);
		const { result } = await first.answer("later");
		assert.equal(result.ok, true, result.error ?? "Worker failed");
		assert.equal(result.answer?.text, "Memory saved: cobalt-739");
		assert.equal(await readFile(join(directory, "effects"), "utf8"), "1");
	});
});

test("cancel aborts busy work durably instead of resuming it on reopen", async () => {
	await withOfflineWorkers(async ({ directory, open }) => {
		const first = open();
		const ready = await first.worker.ready;
		await first.worker.input("cancelled", "recover unsafe", false);
		await marker(directory, "effects");
		await first.worker.cancel();
		const reopened = open();
		const status = await reopened.worker.ready;
		assert.equal(status.conversationId, ready.conversationId);
		assert.equal(status.working, false);
		assert.deepEqual((await reopened.answer("cancelled")).result, { ok: false, aborted: true });
		assert.equal(await readFile(join(directory, "effects"), "utf8"), "1");
	});
});

for (const trusted of [false, true]) {
	test(`worker inherits project trust (${trusted}) for project-local extensions`, async () => {
		await withOfflineWorkers(async ({ directory, spec, open }) => {
			const extensions = join(directory, ".pi", "extensions");
			await mkdir(extensions, { recursive: true });
			await writeFile(
				join(extensions, "trust.ts"),
				`import { writeFileSync } from "node:fs";
export default function() { writeFileSync(${JSON.stringify(join(directory, "project-loaded"))}, "loaded"); }`,
			);
			const { worker, answer } = open({ ...spec, context: { ...spec.context, projectTrusted: trusted } });
			await worker.ready;
			if (trusted) assert.equal(await readFile(join(directory, "project-loaded"), "utf8"), "loaded");
			else await assert.rejects(access(join(directory, "project-loaded")));
			await worker.input("trust", "exercise native tools", false);
			assert.equal((await answer("trust")).result.ok, true);
		});
	});
}
