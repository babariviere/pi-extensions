import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Host-owned per-chat policy, shared with children. No provider I/O or credentials here. */
export class SubscriptionGate {
	#path;
	#interval;
	#reading;
	constructor(path = process.env.PILOT_SUBSCRIPTION_POLICY, intervalMs = 2_000) {
		this.#path = path;
		this.#interval = intervalMs;
	}

	async #read() {
		this.#reading ??= readFile(this.#path, "utf8")
			.then((text) => {
				if (text.length > 65_536) throw new Error("Subscription policy is too large");
				const policy = JSON.parse(text);
				if (policy.version !== 1 || !Array.isArray(policy.windows) || !Array.isArray(policy.forced))
					throw new Error("Invalid subscription policy");
				if (
					!policy.forced.every((key) => typeof key === "string") ||
					!policy.windows.every(
						(window) =>
							window &&
							["anthropic", "openai"].includes(window.provider) &&
							typeof window.label === "string" &&
							(window.resetsAt === undefined || typeof window.resetsAt === "string"),
					)
				)
					throw new Error("Invalid subscription policy windows");
				return policy;
			})
			.catch(() => undefined)
			.finally(() => {
				this.#reading = undefined;
			});
		return this.#reading;
	}

	/** Missing/malformed configured policy holds admission. An unconfigured standalone host is unchanged. */
	async wait(piProvider, signal) {
		const provider = piProvider === "openai-codex" ? "openai" : piProvider === "anthropic" ? "anthropic" : undefined;
		if (!this.#path || !provider) return;
		while (true) {
			signal?.throwIfAborted();
			const policy = await this.#read();
			signal?.throwIfAborted();
			if (
				policy &&
				!policy.windows.some((window) => {
					if (window.provider !== provider) return false;
					const key = JSON.stringify([window.provider, window.label, window.resetsAt ?? null]);
					if (policy.forced.includes(key)) return false;
					const reset = Date.parse(window.resetsAt ?? "");
					return !Number.isFinite(reset) || reset > Date.now();
				})
			)
				return;
			await delay(this.#interval, undefined, { signal });
		}
	}
}
