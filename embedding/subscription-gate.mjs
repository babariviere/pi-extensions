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
				const providers = ["anthropic", "openai"];
				if (
					policy.version !== 1 ||
					!Array.isArray(policy.windows) ||
					(policy.force !== undefined && !Array.isArray(policy.force))
				)
					throw new Error("Invalid subscription policy");
				if (
					!(policy.force ?? []).every((provider) => providers.includes(provider)) ||
					!policy.windows.every(
						(window) =>
							window &&
							providers.includes(window.provider) &&
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

	/**
	 * Missing/malformed configured policy holds admission. An unconfigured standalone host is unchanged.
	 * `force` lists providers whose windows the user chose to ignore (Force work).
	 */
	async wait(piProvider, signal) {
		const provider = piProvider === "openai-codex" ? "openai" : piProvider === "anthropic" ? "anthropic" : undefined;
		if (!this.#path || !provider) return;
		while (true) {
			signal?.throwIfAborted();
			const policy = await this.#read();
			signal?.throwIfAborted();
			if (
				policy &&
				(policy.force?.includes(provider) ||
					!policy.windows.some((window) => {
						if (window.provider !== provider) return false;
						const reset = Date.parse(window.resetsAt ?? "");
						return !Number.isFinite(reset) || reset > Date.now();
					}))
			)
				return;
			await delay(this.#interval, undefined, { signal });
		}
	}
}
