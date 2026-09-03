/**
 * Fail fast on a cause that has already proved itself.
 *
 * A night run has no one to notice a repeating fault, and the loop it forms is
 * expensive: on 2026-09-02 the same launch fault was hit ~90 times over ten
 * hours, 14 of them on a single ledger item, plus some 35 probe children spent
 * bisecting task length, backticks, personas, models and cooldowns. Nothing
 * anywhere counted failures across batches, so every attempt looked like the
 * first one.
 *
 * This is a half-open circuit breaker keyed by the *cause* rather than the task:
 * identical failures are counted, the `limit`-th one opens the circuit, and
 * while it is open the caller refuses to launch and reports the recorded cause
 * instead of paying for it again. After `retryAfterMs` one attempt is allowed
 * through, so a transient outage recovers on its own.
 *
 * Pure and clock-injected: no timers, no I/O, and every decision is a function
 * of what was recorded.
 */

/** Consecutive identical failures that open the circuit. */
export const DEFAULT_CAUSE_LIMIT = 3;

/** How long the circuit stays open before one attempt is let through. */
export const DEFAULT_RETRY_AFTER_MS = 10 * 60 * 1000;

export interface CauseVerdict {
	/** The normalized cause that opened the circuit. */
	signature: string;
	/** How many times it was seen in a row. */
	count: number;
	/** The last raw error text, for the report. */
	error: string;
}

/**
 * Collapse an error to what makes two occurrences "the same failure": ids,
 * paths, hashes and numbers vary from run to run and say nothing about the
 * cause. `pane w2J:p3D timed out` and `pane w2J:p9Z timed out` must count as
 * one thing, or the breaker never trips.
 */
export function causeSignature(error: string | undefined): string {
	return (error ?? "unknown")
		.toLowerCase()
		.replaceAll(/\/[^\s"']+/g, "<path>")
		.replaceAll(/\b[0-9a-f]{6,}\b/g, "<id>")
		.replaceAll(/\b\w+:\w+\b/g, "<id>")
		.replaceAll(/\d+/g, "#")
		.replaceAll(/\s+/g, " ")
		.trim()
		.slice(0, 120);
}

export class CauseBreaker {
	readonly #limit: number;
	readonly #retryAfterMs: number;
	readonly #now: () => number;
	#signature: string | undefined;
	#error = "";
	#count = 0;
	#openedAt = 0;

	constructor(opts: { limit?: number; retryAfterMs?: number; now?: () => number } = {}) {
		this.#limit = opts.limit ?? DEFAULT_CAUSE_LIMIT;
		this.#retryAfterMs = opts.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
		this.#now = opts.now ?? Date.now;
	}

	/**
	 * Count one failure. A different cause than the one being tracked restarts the
	 * count: two alternating faults are two problems, not a streak.
	 */
	record(error: string | undefined): void {
		const signature = causeSignature(error);
		if (signature !== this.#signature) {
			this.#signature = signature;
			this.#count = 0;
		}
		this.#error = error ?? signature;
		this.#count++;
		if (this.#count === this.#limit) this.#openedAt = this.#now();
	}

	/** Anything that worked proves the cause is gone. */
	clear(): void {
		this.#signature = undefined;
		this.#error = "";
		this.#count = 0;
		this.#openedAt = 0;
	}

	/**
	 * The cause to refuse for, if any. Half-open: once `retryAfterMs` has passed
	 * the count is dropped back below the limit so exactly one attempt gets
	 * through, and a failure re-opens the circuit immediately.
	 */
	verdict(): CauseVerdict | undefined {
		if (this.#signature === undefined || this.#count < this.#limit) return undefined;
		if (this.#now() - this.#openedAt >= this.#retryAfterMs) {
			this.#count = this.#limit - 1;
			return undefined;
		}
		return { signature: this.#signature, count: this.#count, error: this.#error };
	}
}
