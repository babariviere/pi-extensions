import { awaitWithContext } from "@earendil-works/chord/context";
import { GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";

/** Safe pause for hosts running native tools sequentially per conversation. Never aborts a tool. */
export class ToolDrain {
	#paused = false;
	#allowed = new Map();
	#release;
	#resumed = Promise.resolve();

	prepare(extension) {
		const wait = async (context) => {
			while (this.#paused) await awaitWithContext(this.#resumed, context);
		};
		return {
			...extension,
			hooks: [
				hook(ToolTask, {
					beforeTool: async (_call, api, context) => {
						// Record permission synchronously when open, before any await. beforeTool is
						// before the unsafe intent checkpoint, so blocked calls survive reopen intact.
						while (this.#paused) await awaitWithContext(this.#resumed, context);
						this.#allowed.set(api.conversationId, api.taskId);
					},
				}),
				hook(GenerationTask, {
					beforeRequest: (_request, _api, context) => wait(context),
					afterResponse: (_message, _api, context) => wait(context),
				}),
				...(extension.hooks ?? []),
			],
		};
	}

	async pause(harness, context) {
		if (!this.#paused) {
			this.#paused = true;
			this.#resumed = new Promise((resolve) => {
				this.#release = resolve;
			});
		}
		const resumed = this.#resumed;
		const watch = await harness.watchTaskGraph(context);
		try {
			// One last admitted task per conversation is enough under sequential execution.
			// Disappearance from this committed graph proves the result was persisted, not
			// merely that execute/afterTool returned. Pending model work need not finish.
			const drained = (graph) => [...this.#allowed.values()].every((id) => !graph.tasks[String(id)]);
			if (drained(watch.value)) return;
			await Promise.race([
				resumed,
				new Promise((resolve, reject) => {
					watch.start(async (graph) => {
						if (drained(graph)) resolve();
					});
					void watch.closed.then(() => reject(new Error("Tool drain closed before settlement")));
				}),
			]);
		} finally {
			await watch.stop();
		}
	}

	resume() {
		this.#paused = false;
		this.#release?.();
		this.#release = undefined;
	}
}
