/** Persistent IPC-only native kernel. Harness history, not files, is canonical. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, Storage } from "@earendil-works/pi-durable";
import { buildNightContract } from "../night-mode/night-run.ts";
import { ConversationRuntime, type ConversationRuntimeOptions, type ReporterHandle } from "./conversation-runtime.ts";
import { openDurableStorage } from "./durable-storage.ts";
import { runCwd, type RunContext, type RunRequest } from "./run.ts";
import type { WorkerCommand, WorkerPacket, WorkerSpec } from "./worker-protocol.ts";

export type { WorkerCommand, WorkerPacket } from "./worker-protocol.ts";
type WorkerEvent = "message" | "disconnect" | "SIGTERM" | "SIGINT";
export interface WorkerHost {
	on(event: WorkerEvent, listener: (message?: unknown) => void): void;
	off(event: WorkerEvent, listener: (message?: unknown) => void): void;
	send(packet: WorkerPacket): Promise<void>;
	exit(code: number): void;
}
export interface WorkerAdapter {
	models: ConversationRuntimeOptions["models"];
	extension: Extension;
	model: ConversationRuntimeOptions["model"];
	thinkingLevel?: ConversationRuntimeOptions["thinkingLevel"];
	onToolsChanged?: (extension: Extension) => void;
	bindHarness(harness: ConversationRuntime["harness"], conversationId: ConversationRuntime["conversationId"]): void;
	prepareInput?(content: string): Promise<string>;
	close(): Promise<void>;
}
export interface WorkerDependencies {
	openStorage(directory: string): Promise<{ storage: Storage; release(): void }>;
	openAdapter(request: RunRequest, context: RunContext): Promise<WorkerAdapter>;
}
const dependencies: WorkerDependencies = {
	openStorage: openDurableStorage,
	openAdapter: async (request, context) => (await import("./native-adapter.ts")).NativeAdapter.open(request, context),
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function frameInput(message: string, spec: WorkerSpec): string {
	const { request, context } = spec;
	if (!context.nightRun) return message;
	const artifacts =
		request.cwd && request.artifactsDir
			? `\nDeliverables directory: \`${request.artifactsDir}\`. Write files that must outlive this workspace there and cite that path as evidence. Your working directory is temporary.\n`
			: "";
	return `${buildNightContract(context.nightRun, request.cwd)}${artifacts}\n${message}`;
}

/** Exported for offline IPC/lifecycle tests with a faux native kernel. */
export function installConversationWorker(host: WorkerHost, deps: WorkerDependencies = dependencies): void {
	let spec: WorkerSpec | undefined;
	let owned: Awaited<ReturnType<WorkerDependencies["openStorage"]>> | undefined;
	let adapter: WorkerAdapter | undefined;
	let runtime: ConversationRuntime | undefined;
	let initialization: Promise<void> | undefined;
	let commands: Promise<void> = Promise.resolve();
	let mode: "pause" | "cancel" | undefined;
	let ending: Promise<void> | undefined;
	let disconnected = false;
	let exited = false;
	const observing = new Set<string>();
	const exit = (code: number) => {
		if (exited) return;
		exited = true;
		host.off("message", onMessage);
		host.off("disconnect", onDisconnect);
		host.off("SIGTERM", onPause);
		host.off("SIGINT", onPause);
		host.exit(code);
	};
	const send = async (packet: WorkerPacket) => {
		if (!disconnected && !exited) await host.send(packet);
	};
	const finish = (nextMode: NonNullable<typeof mode>, failure?: unknown): Promise<void> => {
		if (ending) return ending;
		mode = nextMode;
		ending = (async () => {
			// A disconnected parent cannot enforce its usual bounded private-group teardown.
			const watchdog = setTimeout(() => exit(1), 2_500);
			watchdog.unref();
			let cleanupError = failure;
			try {
				await initialization?.catch((error) => {
					cleanupError ??= error;
				});
				if (nextMode === "cancel") await runtime?.cancel();
				await commands;
			} catch (error) {
				cleanupError ??= error;
			}
			try {
				await runtime?.close();
			} catch (error) {
				cleanupError ??= error;
			}
			try {
				await adapter?.close();
			} catch (error) {
				cleanupError ??= error;
			}
			try {
				// Harness.close owns storage close. Opening may fail before a Harness exists.
				if (!runtime) await owned?.storage.close(BACKGROUND_CONTEXT);
			} catch (error) {
				cleanupError ??= error;
			}
			try {
				owned?.release();
			} catch (error) {
				cleanupError ??= error;
			}
			try {
				if (cleanupError) await send({ type: "error", error: errorText(cleanupError) });
				else if (nextMode === "pause") await send({ type: "paused" });
			} catch {
				/* Parent disappeared during acknowledgment. Durable receipts remain available. */
			} finally {
				clearTimeout(watchdog);
				exit(cleanupError ? 1 : 0);
			}
		})();
		return ending;
	};
	const observe = (id: string, handle: ReporterHandle) => {
		if (observing.has(id) || mode) return;
		observing.add(id);
		void (async () => {
			try {
				const result = await handle.wait();
				if (mode) return;
				const status = await runtime!.status();
				if (!mode) await send({ type: "answer", id, result, status });
			} catch (error) {
				if (!mode) {
					try {
						await send({ type: "error", id, error: errorText(error) });
					} catch {
						onDisconnect();
					}
				}
			}
		})();
	};
	const initialize = async (launch: WorkerSpec) => {
		if (launch.request.night && !launch.context.nightRun)
			throw new Error("Active night contract unavailable; refusing to resume without its policies");
		// Wait for a closing owner's lease, never steal it or open a concurrent native kernel.
		const waitUntil = Math.min(launch.context.deadlineAt ?? Infinity, Date.now() + 2_000);
		while (!owned) {
			try {
				owned = await deps.openStorage(launch.directory);
			} catch (error) {
				if (
					mode ||
					Date.now() >= waitUntil ||
					!(error instanceof Error) ||
					!error.message.startsWith("Durable subagent storage already has an owner:")
				)
					throw error;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
		if (mode) return;
		const pinned = await ConversationRuntime.pinnedAgent(owned.storage);
		const request = pinned
			? {
					...launch.request,
					overrides: {
						...launch.request.overrides,
						model: `${pinned.model.provider}/${pinned.model.modelId}`,
						...(pinned.thinkingLevel ? { thinking: pinned.thinkingLevel } : {}),
					},
				}
			: launch.request;
		adapter = await deps.openAdapter(request, launch.context);
		runtime = await ConversationRuntime.open(owned.storage, {
			models: adapter.models,
			extension: adapter.extension,
			model: adapter.model,
			thinkingLevel: adapter.thinkingLevel,
			cwd: runCwd(launch.request, launch.context),
		});
		adapter.onToolsChanged = (extension) => runtime!.installExtension(extension);
		adapter.bindHarness(runtime.harness, runtime.conversationId);
		if (mode) return;
		// Retained host stop intent/expired work must be withdrawn before recovery
		// can resume generation or native tools. Opening alone never resumes it.
		if (launch.stopOnOpen || (launch.context.deadlineAt !== undefined && launch.context.deadlineAt <= Date.now()))
			await runtime.stop();
		if (mode) return;
		await send({ type: "ready", status: await runtime.status() });
		if (mode) return;
		for (const { requestId, handle } of await runtime.reporters()) observe(requestId, handle);
		runtime.resume();
	};
	const execute = async (packet: Extract<WorkerCommand, { type: "input" | "stop" | "status" }>) => {
		await initialization;
		if (mode) return;
		if (!runtime || !adapter || !spec) throw new Error("Worker has not started");
		if (packet.type === "input") {
			const persisted = await runtime.admittedContent(packet.id);
			const content =
				persisted ??
				(adapter.prepareInput
					? await adapter.prepareInput(frameInput(packet.message, spec))
					: frameInput(packet.message, spec));
			if (mode) return;
			const handle = await runtime.admit(packet.id, content, packet.followUp);
			if (mode) return;
			// Never wait for a Reporter on the command line. stop/status/send must remain usable.
			await send({ type: "accepted", id: packet.id, status: await runtime.status() });
			observe(packet.id, handle);
		} else {
			if (packet.type === "stop") await runtime.stop();
			if (!mode)
				await send({
					type: packet.type === "stop" ? "stopped" : "status",
					id: packet.id,
					status: await runtime.status(),
				});
		}
	};
	const onPause = () => {
		void finish("pause");
	};
	const onDisconnect = () => {
		disconnected = true;
		onPause();
	};
	const onMessage = (message?: unknown) => {
		if (!message || typeof message !== "object" || mode) return;
		const packet = message as WorkerCommand;
		if (packet.type === "pause") {
			onPause();
			return;
		}
		if (packet.type === "cancel") {
			void finish("cancel");
			return;
		}
		if (packet.type === "start") {
			if (spec) return;
			spec = packet.spec;
			initialization = initialize(packet.spec);
			void initialization.catch((error) => {
				void finish("pause", error);
			});
			return;
		}
		if (packet.type !== "input" && packet.type !== "stop" && packet.type !== "status") return;
		commands = commands
			.then(() => execute(packet))
			.catch(async (error) => {
				if (!mode) {
					try {
						await send({ type: "error", id: packet.id, error: errorText(error) });
					} catch {
						onDisconnect();
					}
				}
			});
	};
	host.on("message", onMessage);
	host.on("disconnect", onDisconnect);
	host.on("SIGTERM", onPause);
	host.on("SIGINT", onPause);
}

if (typeof process.send === "function") {
	installConversationWorker({
		on: (event, listener) => {
			process.on(event, listener);
		},
		off: (event, listener) => {
			process.off(event, listener);
		},
		send: (packet) =>
			new Promise((resolve, reject) => {
				if (!process.connected) {
					reject(new Error("Parent IPC disconnected"));
					return;
				}
				process.send!(packet, (error: Error | null) => (error ? reject(error) : resolve()));
			}),
		exit: (code) => {
			// Only kill a detached private process group, never the caller's inherited group.
			if (process.platform !== "win32") {
				try {
					process.kill(-process.pid, "SIGKILL");
				} catch {
					/* Not a private group leader. */
				}
			}
			process.exit(code);
		},
	});
}
