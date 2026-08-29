import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
	CLOSED_DISPLAY_MODE_SCRIPT,
	END_SESSION_SCRIPT,
	RENEW_MARGIN_MS,
	SESSION_ACTIVE_SCRIPT,
	SESSION_MINUTES,
	VERIFY_INTERVAL_MS,
	WakeLock,
	isPermanentFailure,
	isWakeLockPreference,
	parseSessionActive,
	selectBackend,
	shouldRenew,
	startSessionScript,
} from "./wake-lock.ts";
import type { ScriptResult, WakeLockDeps } from "./wake-lock.ts";

describe("selectBackend", () => {
	it("prefers amphetamine when installed", () => {
		assert.equal(
			selectBackend({
				preference: "auto",
				platform: "darwin",
				amphetamineInstalled: true,
			}),
			"amphetamine",
		);
	});

	it("falls back to caffeinate when amphetamine is missing", () => {
		assert.equal(
			selectBackend({
				preference: "auto",
				platform: "darwin",
				amphetamineInstalled: false,
			}),
			"caffeinate",
		);
	});

	it("honours an explicit backend even when the app is missing", () => {
		assert.equal(
			selectBackend({
				preference: "amphetamine",
				platform: "darwin",
				amphetamineInstalled: false,
			}),
			"amphetamine",
		);
		assert.equal(
			selectBackend({
				preference: "caffeinate",
				platform: "darwin",
				amphetamineInstalled: true,
			}),
			"caffeinate",
		);
	});

	it("is a no-op off darwin or when disabled", () => {
		assert.equal(
			selectBackend({
				preference: "auto",
				platform: "linux",
				amphetamineInstalled: false,
			}),
			"none",
		);
		assert.equal(
			selectBackend({
				preference: "off",
				platform: "darwin",
				amphetamineInstalled: true,
			}),
			"none",
		);
	});
});

describe("scripts", () => {
	it("builds a bounded session with display sleep off", () => {
		const script = startSessionScript(30);
		assert.match(script, /^tell application "Amphetamine" to start new session/);
		assert.match(script, /duration:30/);
		assert.match(script, /displaySleepAllowed:false/);
	});

	// A quoted interval fails at runtime with AppleEvent handler failed (-10000).
	it("leaves the interval enum unquoted", () => {
		assert.match(startSessionScript(30), /interval:minutes[,}]/);
		assert.doesNotMatch(startSessionScript(30), /interval:"/);
	});

	it("never emits a zero or fractional duration", () => {
		assert.match(startSessionScript(0), /duration:1/);
		assert.match(startSessionScript(2.7), /duration:2/);
	});

	it("parses the session status boolean", () => {
		assert.equal(parseSessionActive("true\n"), true);
		assert.equal(parseSessionActive(" TRUE "), true);
		assert.equal(parseSessionActive("false\n"), false);
		assert.equal(parseSessionActive(""), false);
	});
});

describe("shouldRenew", () => {
	it("renews when nothing is held", () => {
		assert.equal(shouldRenew(undefined, 1_000), true);
	});

	it("renews inside the margin", () => {
		const now = 1_000_000;
		assert.equal(shouldRenew(now + RENEW_MARGIN_MS - 1, now), true);
		assert.equal(shouldRenew(now + RENEW_MARGIN_MS + 1, now), false);
	});
});

describe("isPermanentFailure", () => {
	it("detects automation denial and a missing app", () => {
		assert.equal(isPermanentFailure("execution error: Not authorized to send Apple events"), true);
		assert.equal(isPermanentFailure("error -1743"), true);
		assert.equal(isPermanentFailure("Can\u2019t find application \u201cAmphetamine\u201d"), true);
	});

	it("treats a transient error as retryable", () => {
		assert.equal(isPermanentFailure("AppleEvent timed out"), false);
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
	scripts: string[];
	children: FakeChild[];
	warnings: string[];
	advance: (ms: number) => void;
}

function harness(
	options: { platform?: string; installed?: boolean; result?: (script: string) => ScriptResult } = {},
): Harness {
	const scripts: string[] = [];
	const children: FakeChild[] = [];
	const warnings: string[] = [];
	let clock = 1_000_000;
	// Default Mac: session starts fine and survives a closed lid.
	const ok: ScriptResult = { code: 0, stdout: "true", stderr: "" };
	return {
		scripts,
		children,
		warnings,
		advance: (ms) => {
			clock += ms;
		},
		deps: {
			platform: options.platform ?? "darwin",
			amphetamineInstalled: () => options.installed ?? true,
			now: () => clock,
			warn: (message) => warnings.push(message),
			runScript: async (script) => {
				scripts.push(script);
				return options.result ? options.result(script) : ok;
			},
			spawnCaffeinate: () => {
				const child = new FakeChild();
				children.push(child);
				return child as unknown as ReturnType<WakeLockDeps["spawnCaffeinate"]>;
			},
		},
	};
}

/** How many sessions were started. */
const starts = (h: Harness): number => h.scripts.filter((s) => s.includes("start new session")).length;

describe("WakeLock with amphetamine", () => {
	it("starts one bounded session and reports it", async () => {
		const h = harness();
		const lock = new WakeLock("auto", h.deps);
		await lock.acquire();
		assert.equal(starts(h), 1);
		assert.match(h.scripts[0], /start new session/);
		const status = lock.status();
		assert.equal(status.backend, "amphetamine");
		assert.equal(status.held, true);
		assert.equal(h.children.length, 0);
		assert.equal(h.warnings.length, 0);
	});

	it("is idempotent inside the session window", async () => {
		const h = harness();
		const lock = new WakeLock("auto", h.deps);
		await lock.acquire();
		h.advance(30_000);
		await lock.acquire();
		await lock.acquire();
		assert.equal(starts(h), 1);
	});

	it("re-arms the session before it lapses", async () => {
		const h = harness();
		const lock = new WakeLock("auto", h.deps);
		await lock.acquire();
		h.advance(SESSION_MINUTES * 60_000 - RENEW_MARGIN_MS);
		await lock.acquire();
		assert.equal(starts(h), 2);
	});

	it("re-arms when the session vanished behind our back", async () => {
		let active = true;
		const h = harness({
			result: (script) =>
				script === SESSION_ACTIVE_SCRIPT
					? { code: 0, stdout: active ? "true" : "false", stderr: "" }
					: { code: 0, stdout: "true", stderr: "" },
		});
		const lock = new WakeLock("auto", h.deps);
		await lock.acquire();
		active = false;
		h.advance(VERIFY_INTERVAL_MS);
		await lock.acquire();
		assert.equal(starts(h), 2);
	});

	it("warns once when the lid would still put the Mac to sleep", async () => {
		const h = harness({
			result: (script) =>
				script === CLOSED_DISPLAY_MODE_SCRIPT
					? { code: 0, stdout: "false", stderr: "" }
					: { code: 0, stdout: "true", stderr: "" },
		});
		const lock = new WakeLock("auto", h.deps);
		await lock.acquire();
		assert.equal(h.warnings.length, 1);
		assert.match(h.warnings[0], /lid is closed/);
		assert.equal(lock.status().backend, "amphetamine", "still holds the lock");

		h.advance(SESSION_MINUTES * 60_000);
		await lock.acquire();
		assert.equal(h.warnings.length, 1);
	});

	it("ends the session on release", async () => {
		const h = harness();
		const lock = new WakeLock("auto", h.deps);
		await lock.acquire();
		await lock.release();
		assert.equal(h.scripts.at(-1), END_SESSION_SCRIPT);
		assert.equal(lock.status().held, false);
		await lock.release();
		assert.equal(h.scripts.filter((s) => s === END_SESSION_SCRIPT).length, 1, "release is idempotent");
	});

	it("falls back to caffeinate when automation is denied", async () => {
		const h = harness({
			result: () => ({
				code: 1,
				stdout: "",
				stderr: "execution error: Not authorized to send Apple events",
			}),
		});
		const lock = new WakeLock("auto", h.deps);
		await lock.acquire();
		assert.equal(h.children.length, 1);
		assert.equal(lock.status().backend, "caffeinate");
		assert.equal(lock.backend, "caffeinate");
		assert.equal(h.warnings.length, 1);

		const before = h.scripts.length;
		await lock.acquire();
		assert.equal(h.scripts.length, before, "stops retrying osascript");
		assert.equal(h.warnings.length, 1, "warns once");
	});
});

describe("WakeLock with caffeinate", () => {
	it("holds a single child and kills it on release", async () => {
		const h = harness();
		const lock = new WakeLock("caffeinate", h.deps);
		await lock.acquire();
		await lock.acquire();
		assert.equal(h.children.length, 1);
		assert.equal(h.scripts.length, 0, "never talks to amphetamine");
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
		assert.equal(h.scripts.length, 0);
		assert.equal(lock.status().held, false);
		assert.equal(lock.status().configured, "none");
	});

	it("does nothing when turned off", async () => {
		const h = harness();
		const lock = new WakeLock("off", h.deps);
		await lock.acquire();
		assert.equal(h.children.length, 0);
		assert.equal(h.scripts.length, 0);
	});
});

describe("isWakeLockPreference", () => {
	it("accepts the four spellings and nothing else", () => {
		for (const value of ["auto", "amphetamine", "caffeinate", "off"]) assert.equal(isWakeLockPreference(value), true);
		assert.equal(isWakeLockPreference("Amphetamine"), false);
		assert.equal(isWakeLockPreference(undefined), false);
		assert.equal(isWakeLockPreference(1), false);
	});
});
