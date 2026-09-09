import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { WakeLock, isWakeLockPreference, selectBackend } from "./wake-lock.ts";
import type { CommandResult, WakeLockDeps } from "./wake-lock.ts";

describe("selectBackend", () => {
	it("uses pmset by default and when explicitly selected", () => {
		assert.equal(selectBackend({ preference: "auto", platform: "darwin" }), "pmset");
		assert.equal(selectBackend({ preference: "pmset", platform: "darwin" }), "pmset");
	});

	it("honours the caffeinate preference", () => {
		assert.equal(selectBackend({ preference: "caffeinate", platform: "darwin" }), "caffeinate");
	});

	it("is a no-op off darwin or when disabled", () => {
		assert.equal(selectBackend({ preference: "auto", platform: "linux" }), "none");
		assert.equal(selectBackend({ preference: "off", platform: "darwin" }), "none");
	});
});

/** Minimal stand-in for the `caffeinate` child process. */
class FakeChild extends EventEmitter {
	killed = false;
	unref(): void {}
	kill(): boolean {
		this.killed = true;
		return true;
	}
}

interface Harness {
	deps: WakeLockDeps;
	pmsetCalls: boolean[];
	children: FakeChild[];
	warnings: string[];
}

function harness(
	options: {
		platform?: string;
		result?: (enabled: boolean, call: number) => CommandResult;
		spawnFails?: boolean;
	} = {},
): Harness {
	const pmsetCalls: boolean[] = [];
	const children: FakeChild[] = [];
	const warnings: string[] = [];
	return {
		pmsetCalls,
		children,
		warnings,
		deps: {
			platform: options.platform ?? "darwin",
			warn: (message) => warnings.push(message),
			setDisableSleep: async (enabled) => {
				pmsetCalls.push(enabled);
				return options.result?.(enabled, pmsetCalls.length) ?? { code: 0, stderr: "" };
			},
			spawnCaffeinate: () => {
				if (options.spawnFails) return undefined;
				const child = new FakeChild();
				children.push(child);
				return child as unknown as ReturnType<WakeLockDeps["spawnCaffeinate"]>;
			},
		},
	};
}

describe("WakeLock with pmset", () => {
	it("enables closed-lid wake, holds caffeinate, and reports pmset", async () => {
		const h = harness();
		const lock = new WakeLock("auto", h.deps);
		await lock.acquire();
		await lock.acquire();
		assert.deepEqual(h.pmsetCalls, [true]);
		assert.equal(h.children.length, 1);
		assert.deepEqual(lock.status(), { backend: "pmset", configured: "pmset", held: true });
	});

	it("restores closed-lid sleep and kills caffeinate on release", async () => {
		const h = harness();
		const lock = new WakeLock("auto", h.deps);
		await lock.acquire();
		await lock.release();
		await lock.release();
		assert.deepEqual(h.pmsetCalls, [true, false]);
		assert.equal(h.children[0].killed, true);
		assert.equal(lock.status().held, false);
	});

	it("still holds with pmset when caffeinate cannot start", async () => {
		const h = harness({ spawnFails: true });
		const lock = new WakeLock("auto", h.deps);
		await lock.acquire();
		assert.deepEqual(lock.status(), { backend: "pmset", configured: "pmset", held: true });
	});

	it("falls back to caffeinate when passwordless sudo fails", async () => {
		const h = harness({ result: () => ({ code: 1, stderr: "sudo: a password is required" }) });
		const lock = new WakeLock("auto", h.deps);
		await lock.acquire();
		await lock.acquire();
		assert.deepEqual(h.pmsetCalls, [true], "stops retrying the failed enable command");
		assert.equal(h.children.length, 1);
		assert.deepEqual(lock.status(), { backend: "caffeinate", configured: "caffeinate", held: true });
		assert.equal(h.warnings.length, 1);
		assert.match(h.warnings[0], /passwordless sudo/);
	});

	it("retries a failed restore", async () => {
		const h = harness({
			result: (enabled, call) =>
				!enabled && call === 2 ? { code: 1, stderr: "restore failed" } : { code: 0, stderr: "" },
		});
		const lock = new WakeLock("auto", h.deps);
		await lock.acquire();
		await lock.release();
		assert.equal(lock.status().held, true);
		await lock.release();
		assert.deepEqual(h.pmsetCalls, [true, false, false]);
		assert.equal(lock.status().held, false);
		assert.equal(h.warnings.length, 1);
	});
});

describe("WakeLock with caffeinate", () => {
	it("holds one child without calling pmset and kills it on release", async () => {
		const h = harness();
		const lock = new WakeLock("caffeinate", h.deps);
		await lock.acquire();
		await lock.acquire();
		assert.equal(h.children.length, 1);
		assert.deepEqual(h.pmsetCalls, []);
		assert.equal(lock.status().backend, "caffeinate");
		await lock.release();
		assert.equal(h.children[0].killed, true);
		assert.equal(lock.status().held, false);
	});

	it("re-spawns after the child dies on its own", async () => {
		const h = harness();
		const lock = new WakeLock("caffeinate", h.deps);
		await lock.acquire();
		h.children[0].emit("exit", 0);
		assert.equal(lock.status().held, false);
		await lock.acquire();
		assert.equal(h.children.length, 2);
	});
});

describe("WakeLock disabled", () => {
	it("does nothing off darwin", async () => {
		const h = harness({ platform: "linux" });
		const lock = new WakeLock("auto", h.deps);
		await lock.acquire();
		assert.equal(h.children.length, 0);
		assert.deepEqual(h.pmsetCalls, []);
		assert.equal(lock.status().configured, "none");
	});

	it("does nothing when turned off", async () => {
		const h = harness();
		const lock = new WakeLock("off", h.deps);
		await lock.acquire();
		assert.equal(h.children.length, 0);
		assert.deepEqual(h.pmsetCalls, []);
	});
});

describe("isWakeLockPreference", () => {
	it("accepts supported values only", () => {
		for (const value of ["auto", "pmset", "caffeinate", "off"]) assert.equal(isWakeLockPreference(value), true);
		assert.equal(isWakeLockPreference("amphetamine"), false);
		assert.equal(isWakeLockPreference(undefined), false);
		assert.equal(isWakeLockPreference(1), false);
	});
});
