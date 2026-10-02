import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { MemoryStorage, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import type { ActionContext } from "../shared/action-tools.ts";
import { AgentRunRegistry } from "./agent-run-monitor.ts";
import { AgentsProvider } from "./agents-provider.ts";
import { RunLauncher } from "./backend.ts";
import { DurableRunBook } from "./durable-run-book.ts";

class AdmissionStorage extends MemoryStorage {
	admission: (() => Promise<void>) | undefined;
	override async commit(writes: readonly StorageWrite[], context: Parameters<Storage["commit"]>[1]) {
		const gate = this.admission;
		this.admission = undefined;
		await gate?.();
		return super.commit(writes, context);
	}
}

const context: ActionContext = {
	cwd: tmpdir(),
	signal: undefined,
	parentToolCallId: "admission-test",
	nestedToolCallId: "admission-test_child",
	extensionContext: {} as never,
	update: () => {},
};

for (const fails of [false, true]) {
	test(`durable admission ${fails ? "failure prevents" : "commit precedes"} child launch`, async () => {
		const storage = new AdmissionStorage();
		const book = await DurableRunBook.open(storage);
		const registry = new AgentRunRegistry();
		let calls = 0;
		const provider = new AgentsProvider(
			() => ({ cwd: tmpdir(), sessionId: undefined, sessionFile: undefined }),
			registry,
			() => ({ timeoutMs: 1_000, waitMs: 0 }),
			book,
			new RunLauncher(async () => {
				calls++;
				return [];
			}),
		);
		let entered!: () => void;
		let release!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		storage.admission = async () => {
			entered();
			await gate;
			if (fails) throw new Error("Admission failed");
		};
		const launched = provider.invoke("start", { task: "inspect" }, context);
		const failure = fails ? assert.rejects(launched, /Admission failed/) : undefined;
		try {
			await ready;
			assert.equal(calls, 0, "no child may launch while its admission is uncommitted");
			release();
			if (fails) {
				await failure;
				assert.equal(calls, 0);
			} else {
				const result = (await launched) as { runId: string };
				assert.equal(calls, 1);
				assert.equal((await book.wait(result.runId, 1_000)).state, "settled");
			}
		} finally {
			release();
			await book.close();
		}
	});
}
