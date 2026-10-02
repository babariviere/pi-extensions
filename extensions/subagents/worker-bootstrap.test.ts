import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { builtinAgent } from "./discovery.ts";
import type { WorkerLaunch } from "./conversation-backend.ts";
import type { WorkerPacket } from "./conversation-worker.ts";

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
		let packet: WorkerPacket | undefined;
		child.on("message", (message) => {
			packet = message as WorkerPacket;
		});
		const deadline = setTimeout(() => {
			child.kill("SIGKILL");
		}, 20_000);
		const closed = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", () => resolve());
		});
		const launch: WorkerLaunch = {
			type: "start",
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
			requestId: "peerless:0",
		};
		try {
			child.send(launch);
			await closed;
			assert.equal(packet?.type, "result", stderr || "Worker produced no result");
			if (packet?.type !== "result") assert.fail("Missing worker result");
			assert.equal(packet.result.ok, true, packet.result.error ?? stderr);
			assert.equal(packet.result.output, "PEERLESS_DURABLE_OK");
			assert.ok(packet.result.conversationId);
		} finally {
			clearTimeout(deadline);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await closed.catch(() => {});
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
