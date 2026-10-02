import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { builtinAgent } from "./discovery.ts";
import { signalProcessTree } from "./process-tree.ts";
import type { WorkerCommand, WorkerPacket, WorkerSpec } from "./worker-protocol.ts";

test("managed worker boots without host-provided SDK peers in its extension package", async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-peerless-worker-"));
	const installed = join(directory, "installed");
	const source = fileURLToPath(new URL("../", import.meta.url));
	try {
		await cp(source, join(installed, "extensions"), {
			recursive: true,
			filter: (path) => !path.endsWith(".test.ts") && !path.includes("/fixtures/"),
		});
		await writeFile(join(installed, "package.json"), JSON.stringify({ type: "module" }));
		await mkdir(join(installed, "node_modules", "@earendil-works"), { recursive: true });
		// Only real runtime dependencies are installed. Pi intentionally suppresses SDK peers.
		for (const name of ["chord", "pi-durable"]) {
			await symlink(
				fileURLToPath(new URL(`../../node_modules/@earendil-works/${name}`, import.meta.url)),
				join(installed, "node_modules", "@earendil-works", name),
				"dir",
			);
		}
		await assert.rejects(access(join(installed, "node_modules", "@earendil-works", "pi-coding-agent")));
		await assert.rejects(access(join(installed, "node_modules", "@earendil-works", "pi-ai")));
		const fauxUrl = import.meta.resolve("@earendil-works/pi-ai/providers/faux");
		const fixture = join(directory, "offline.ts");
		await writeFile(
			fixture,
			`import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(fauxUrl)};
export default function(pi) {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("PEERLESS_DURABLE_OK")]);
	pi.registerProvider(faux.provider);
}`,
		);
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({
				extensions: [fixture],
				defaultProvider: "faux",
				defaultModel: "faux-1",
				cacheWarming: "off",
			}),
		);
		const child = spawn(process.execPath, [join(installed, "extensions", "subagents", "worker-bootstrap.mjs")], {
			cwd: directory,
			detached: true,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			env: {
				...process.env,
				PI_OFFLINE: "1",
				PI_CODING_AGENT_DIR: directory,
				PI_CODE_MODE_SUBAGENT: "1",
				PI_SUBAGENT_HOST_PACKAGE_DIR: getPackageDir(),
			},
		});
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr = (stderr + String(chunk)).slice(-16_384);
		});
		const packets: WorkerPacket[] = [];
		child.on("message", (message) => {
			packets.push(message as WorkerPacket);
		});
		const deadline = setTimeout(() => {
			signalProcessTree(child, "SIGKILL");
		}, 20_000);
		let ended = false;
		const closed = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", () => {
				ended = true;
				resolve();
			});
		});
		void closed.catch(() => {});
		const waitPacket = async <T extends WorkerPacket["type"]>(
			type: T,
			id?: string,
		): Promise<Extract<WorkerPacket, { type: T }>> => {
			const until = Date.now() + 15_000;
			while (true) {
				const packet = packets.find(
					(packet) => packet.type === type && (id === undefined || ("id" in packet && packet.id === id)),
				);
				if (packet) return packet as Extract<WorkerPacket, { type: T }>;
				const error = packets.find((packet) => packet.type === "error");
				if (error?.type === "error") assert.fail(error.error);
				assert.ok(!ended && Date.now() < until, stderr || `Missing worker packet: ${type}`);
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		};
		const send = (command: WorkerCommand) => child.send(command);
		const spec: WorkerSpec = {
			name: "peerless",
			request: {
				agent: builtinAgent(),
				task: "Reply with a confirmation",
				index: 0,
				overrides: { model: "faux/faux-1" },
			},
			context: {
				cwd: directory,
				sessionId: "peerless",
				sessionFile: join(directory, "parent.jsonl"),
				runId: "peerless",
				timeoutMs: 20_000,
				projectTrusted: false,
			},
			directory: join(directory, "harness"),
		};
		try {
			send({ type: "start", spec });
			const ready = await waitPacket("ready");
			assert.equal(ready.status.working, false);
			assert.equal(ready.status.lastAnswer, undefined);
			assert.ok(ready.status.conversationId);
			send({ type: "input", id: "peerless:0", message: "Reply with a confirmation", followUp: false });
			const accepted = await waitPacket("accepted", "peerless:0");
			assert.equal(accepted.status.conversationId, ready.status.conversationId);
			const answer = await waitPacket("answer", "peerless:0");
			assert.equal(answer.result.ok, true, answer.result.error ?? stderr);
			assert.equal(answer.result.answer?.text, "PEERLESS_DURABLE_OK");
			assert.ok(answer.result.answer?.id);
			assert.equal("outputPath" in answer.result, false);
			// Completing an input does not terminate a persistent worker.
			send({ type: "status", id: "status" });
			const status = (await waitPacket("status", "status")).status;
			assert.equal(status.working, false);
			assert.deepEqual(status.lastAnswer, answer.result.answer);
			send({ type: "stop", id: "stop" });
			assert.deepEqual((await waitPacket("stopped", "stop")).status, status);
			send({ type: "pause" });
			await waitPacket("paused");
			await closed;
			await assert.rejects(access(join(directory, "harness", "output.md")));
		} finally {
			clearTimeout(deadline);
			if (child.exitCode === null && child.signalCode === null) signalProcessTree(child, "SIGKILL");
			await closed.catch(() => {});
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
