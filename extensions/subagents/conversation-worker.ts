/** IPC-only worker. No prompts or credentials travel through argv. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, Storage } from "@earendil-works/pi-durable";
import { ConversationRuntime, type ConversationRuntimeOptions } from "./conversation-runtime.ts";
import { openDurableStorage } from "./durable-storage.ts";
import { outputPathFor, resolveRunOutput } from "./output.ts";
import { runPaths } from "./paths.ts";
import { formatTaskMessage } from "./pi-args.ts";
import { baseResult, runCwd, type RunContext, type RunRequest, type RunResult } from "./run.ts";

export type WorkerCommand =
	| {
			type: "start";
			request: RunRequest;
			context: RunContext;
			directory: string;
			requestId: string;
	  }
	| { type: "pause" }
	| { type: "cancel" };
export type WorkerPacket = { type: "result"; result: RunResult } | { type: "paused" };
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

/** Exported for offline IPC/lifecycle tests with a faux native kernel. */
export function installConversationWorker(host: WorkerHost, deps: WorkerDependencies = dependencies): void {
	let launch: Extract<WorkerCommand, { type: "start" }> | undefined;
	let owned: Awaited<ReturnType<WorkerDependencies["openStorage"]>> | undefined;
	let adapter: WorkerAdapter | undefined;
	let runtime: ConversationRuntime | undefined;
	let initialization: Promise<void> | undefined;
	let mode: "pause" | "cancel" | "result" | undefined;
	let ending: Promise<void> | undefined;
	let disconnected = false;
	let exited = false;
	const exit = (code: number) => {
		if (exited) return;
		exited = true;
		host.off("message", onMessage);
		host.off("disconnect", onDisconnect);
		host.off("SIGTERM", onPause);
		host.off("SIGINT", onPause);
		host.exit(code);
	};
	const failed = (error: unknown, cancelled = false): RunResult => ({
		agent: launch?.request.agent.config.name ?? "unknown",
		scope: launch?.request.agent.scope ?? "unknown",
		backend: "durable",
		ok: false,
		output: "",
		...(runtime ? { conversationId: String(runtime.conversationId) } : {}),
		error: cancelled ? "Subagent cancelled" : error instanceof Error ? error.message : String(error),
		failure: cancelled ? "cancelled" : runtime ? "run" : "launch",
	});
	const finish = (nextMode: NonNullable<typeof mode>, result?: RunResult): Promise<void> => {
		if (ending) return ending;
		mode = nextMode;
		ending = (async () => {
			// A disconnected parent cannot enforce its usual bounded group teardown.
			const watchdog = setTimeout(() => exit(1), 2_500);
			watchdog.unref();
			let cleanupError: unknown;
			try {
				await initialization?.catch((error) => {
					cleanupError = error;
				});
				if (nextMode === "cancel") await runtime?.cancel();
			} catch (error) {
				cleanupError = error;
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
				if (!disconnected) {
					if (nextMode === "pause" && !cleanupError) await host.send({ type: "paused" });
					else
						await host.send({
							type: "result",
							result:
								nextMode === "cancel"
									? failed(cleanupError, true)
									: cleanupError
										? failed(cleanupError)
										: result!,
						});
				}
			} catch {
				/* The parent disappeared during acknowledgement. Work remains in storage. */
			} finally {
				clearTimeout(watchdog);
				exit(cleanupError ? 1 : 0);
			}
		})();
		return ending;
	};
	const execute = async () => {
		try {
			await initialization;
			if (mode || !launch || !runtime || !adapter) return;
			const { request, context, requestId } = launch;
			const content = formatTaskMessage(request.task, {
				reads: request.reads,
				night: request.night,
				workspacePath: request.cwd,
				artifactsDir: request.artifactsDir,
			});
			const admitted = await runtime.admittedContent(requestId);
			const input = admitted ?? (adapter.prepareInput ? await adapter.prepareInput(content) : content);
			if (mode) return;
			const result = await runtime.run(requestId, input);
			if (mode) return;
			const paths = runPaths(
				context.sessionFile,
				context.sessionId,
				context.runId,
				request.agent.config.name,
				request.index,
			);
			const outputPath = outputPathFor(context.cwd, paths.outputPath, request.output);
			// Harness history is canonical. Never use a stale native SDK transcript as fallback.
			const resolved = await resolveRunOutput(outputPath, "", {
				fallback: () => result.output,
				finishedCleanly: result.ok,
			});
			if (mode) return;
			await finish("result", {
				...baseResult(request, resolved, result.error, "run"),
				backend: "durable",
				conversationId: String(result.conversationId),
			});
		} catch (error) {
			if (!mode) await finish("result", failed(error));
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
		if (!message || typeof message !== "object") return;
		const packet = message as WorkerCommand;
		if (packet.type === "pause") {
			onPause();
			return;
		}
		if (packet.type === "cancel") {
			void finish("cancel");
			return;
		}
		if (packet.type !== "start" || launch || mode) return;
		launch = packet;
		initialization = (async () => {
			// After parent death, its old worker may still be closing the same Harness.
			// Wait briefly for that OS-held lease, never steal it or start a second kernel.
			const waitUntil = Math.min(packet.context.deadlineAt ?? Infinity, Date.now() + 2_000);
			while (!owned) {
				try {
					owned = await deps.openStorage(packet.directory);
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
			adapter = await deps.openAdapter(packet.request, packet.context);
			runtime = await ConversationRuntime.open(owned.storage, {
				models: adapter.models,
				extension: adapter.extension,
				model: adapter.model,
				thinkingLevel: adapter.thinkingLevel,
				cwd: runCwd(packet.request, packet.context),
			});
			adapter.onToolsChanged = (extension) => runtime!.installExtension(extension);
			adapter.bindHarness(runtime.harness, runtime.conversationId);
		})();
		void execute();
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
			// The host starts a detached worker group. Once state and IPC are flushed,
			// kill that private group so even a tool ignoring cancellation cannot survive.
			// If not a group leader, never signal the caller's inherited process group.
			if (process.platform !== "win32") {
				try {
					process.kill(-process.pid, "SIGKILL");
				} catch {
					/* No private group. */
				}
			}
			process.exit(code);
		},
	});
}
