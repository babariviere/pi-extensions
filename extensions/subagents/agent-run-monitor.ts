/**
 * Progress projection for native subagent tools and their optional widget.
 * The registry stores live rows; the monitor owns the attached tool ticker.
 * Detached rows keep updating until the session-owned child finishes.
 */

import { type AgentProgress, applyStatus, renderProgress } from "./progress.ts";
import type { OnStatus, RunRequest, RunState } from "./run.ts";
import type { ActionContext } from "../shared/action-tools.ts";

const PROGRESS_TICK_MS = 100;

/** Widget-facing view of one in-flight or finished subagent run. */
export interface AgentRun {
	id: string;
	name: string;
	status: string;
	startedAt: number;
	updatedAt: number;
	currentTool?: string;
	error?: string;
	runId?: string;
}

const STATUS_FROM_STATE: Record<RunState, string> = {
	spawning: "queued",
	running: "running",
	done: "completed",
	failed: "failed",
};

/**
 * Live registry of subagent runs, read by the optional compact widget in index.ts.
 */
export class AgentRunRegistry {
	readonly #runs = new Map<string, AgentRun>();
	readonly #listeners = new Set<() => void>();

	list(): AgentRun[] {
		return [...this.#runs.values()];
	}

	upsert(run: AgentRun): void {
		this.#runs.set(run.id, run);
		this.#notify();
	}

	reset(): void {
		this.#runs.clear();
		this.#notify();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {
				// Widget refresh must never break a run.
			}
		}
	}
}

/**
 * Projects a batch's live progress onto the two render targets that share one
 * model: the widget run registry and the compact one-line ticker. The provider
 * calls `start()` before invoking the backend, hands `onStatus` to the
 * `RunContext`, and `stop()` in a `finally`.
 */
export class RunProgressMonitor {
	readonly #registry: AgentRunRegistry;
	readonly #context: ActionContext;
	readonly #runId: string;
	readonly #progress: AgentProgress[];
	readonly #ids: string[];
	#live = false;
	#frame = 0;
	#ticker: ReturnType<typeof setInterval> | undefined;
	readonly #note: string | undefined;

	constructor(
		deps: {
			registry: AgentRunRegistry;
			context: ActionContext;
			runId: string;
			/** Prefix for the ticker line, e.g. the run launcher's fallback reason. */
			note?: string;
		},
		requests: RunRequest[],
	) {
		this.#registry = deps.registry;
		this.#context = deps.context;
		this.#runId = deps.runId;
		this.#note = deps.note === undefined ? undefined : deps.note.slice(0, 120);
		const startedAt = Date.now();
		this.#progress = requests.map((request) => ({
			name: request.agent.config.name,
			scope: request.agent.scope,
			state: "spawning" as RunState,
			startedAt,
		}));
		this.#ids = requests.map((request) => `${deps.runId}-${request.index}`);
	}

	/** Emit the entity rows, publish the first frame, and start the ticker. */
	start(): void {
		for (const [index, row] of this.#progress.entries()) {
			this.#context.activity?.({
				type: "entity",
				id: this.#idAt(index),
				kind: "agent",
				name: row.name,
			});
		}
		this.#live = true;
		this.#publish();
		this.#ticker = setInterval(() => {
			this.#frame++;
			this.#publish();
		}, PROGRESS_TICK_MS);
		this.#ticker.unref?.();
	}

	/** Backend status callback: apply the update and re-publish. */
	readonly onStatus: OnStatus = (index, update) => {
		applyStatus(this.#progress, index, update);
		this.#publish();
	};

	/** Stop the ticker and publish one final (registry-only) frame. */
	stop(): void {
		this.#live = false;
		if (this.#ticker) {
			clearInterval(this.#ticker);
			this.#ticker = undefined;
		}
		this.#publish();
	}

	#idAt(index: number): string {
		return this.#ids[index] ?? `${this.#runId}-${index}`;
	}

	#publish(): void {
		const now = Date.now();
		for (const [index, row] of this.#progress.entries()) {
			this.#registry.upsert({
				id: this.#idAt(index),
				name: row.name,
				status: STATUS_FROM_STATE[row.state],
				startedAt: row.startedAt,
				updatedAt: row.endedAt ?? now,
				// The activity run id is the native tool call id, so the
				// widget can associate these rows with the running program.
				runId: this.#context.parentToolCallId,
				...(row.state === "spawning" || row.state === "running" ? { currentTool: row.state } : {}),
			});
		}
		if (!this.#live) return;
		// renderProgress stays the tested renderer; one line per tick keeps the
		// subagent progress line compact instead of dumping an ANSI block.
		let message = renderProgress(this.#progress, now, { frame: this.#frame }).split("\n").join(" · ");
		if (this.#note) message = `${this.#note} · ${message}`;
		this.#context.update(message);
		this.#context.activity?.({ type: "progress", message });
	}
}
