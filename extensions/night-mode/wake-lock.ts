/**
 * Wake lock for night-mode: keeps the machine awake while an overnight run is
 * in flight.
 *
 * The default `pmset` backend combines two mechanisms on macOS:
 *
 *  - `sudo -n /usr/bin/pmset -c disablesleep 1` prevents clamshell sleep on AC.
 *  - A held `caffeinate -dimsu` child process prevents idle and display sleep.
 *
 * The sudo command must be allowed without a password for the current user. If
 * it is not, the lock warns once and falls back to `caffeinate`. The setting is
 * restored with `disablesleep 0` when the lock is released.
 */

import { type ChildProcess, spawn } from "node:child_process";

/** Which mechanism is actually holding sleep off. */
export type WakeLockBackend = "pmset" | "caffeinate" | "none";

/** User preference, from `nightMode.wakeLock` in settings. */
export type WakeLockPreference = "auto" | "pmset" | "caffeinate" | "off";

export const WAKE_LOCK_PREFERENCES: readonly WakeLockPreference[] = ["auto", "pmset", "caffeinate", "off"];

/** Narrow an untrusted settings value to a wake lock preference. */
export function isWakeLockPreference(value: unknown): value is WakeLockPreference {
	return typeof value === "string" && (WAKE_LOCK_PREFERENCES as readonly string[]).includes(value);
}

/** Resolve the backend to use on this platform. */
export function selectBackend(input: { preference: WakeLockPreference; platform: string }): WakeLockBackend {
	if (input.preference === "off" || input.platform !== "darwin") return "none";
	if (input.preference === "caffeinate") return "caffeinate";
	return "pmset";
}

export interface CommandResult {
	code: number;
	stderr: string;
}

/** Everything the lock touches outside itself, so tests can fake it. */
export interface WakeLockDeps {
	platform: string;
	/** Toggle the charger-only `disablesleep` setting through passwordless sudo. */
	setDisableSleep: (enabled: boolean) => Promise<CommandResult>;
	/** Spawns a `caffeinate`, or `undefined` when it could not start. */
	spawnCaffeinate: () => ChildProcess | undefined;
	/** Reported to the user for a degraded fallback. Once per reason. */
	warn?: (message: string) => void;
}

function setDisableSleep(enabled: boolean): Promise<CommandResult> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: CommandResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		try {
			const child = spawn("/usr/bin/sudo", ["-n", "/usr/bin/pmset", "-c", "disablesleep", enabled ? "1" : "0"], {
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.on("error", (error) => finish({ code: -1, stderr: String(error) }));
			child.on("close", (code) => finish({ code: code ?? -1, stderr }));
		} catch (error) {
			finish({ code: -1, stderr: String(error) });
		}
	});
}

function spawnCaffeinate(): ChildProcess | undefined {
	try {
		// -d display, -i idle sleep, -m disk, -s system sleep on AC, -u user active.
		return spawn("caffeinate", ["-dimsu"], { stdio: "ignore" });
	} catch {
		return undefined;
	}
}

export const defaultWakeLockDeps: WakeLockDeps = {
	platform: process.platform,
	setDisableSleep,
	spawnCaffeinate,
};

export interface WakeLockStatus {
	/** Backend currently holding the lock, `"none"` when nothing is held. */
	backend: WakeLockBackend;
	held: boolean;
	/** Backend that would be used, whether or not the lock is held. */
	configured: WakeLockBackend;
}

/**
 * Holds sleep off for as long as `acquire` keeps being called, and lets go on
 * `release`. Both are idempotent, so callers can mirror their state every tick.
 */
export class WakeLock {
	private readonly deps: WakeLockDeps;
	private readonly preference: WakeLockPreference;
	private pmsetBroken = false;
	private pmsetEnabled = false;
	private caffeinate: ChildProcess | undefined;
	private pending: Promise<void> = Promise.resolve();
	private warned = new Set<string>();

	constructor(preference: WakeLockPreference = "auto", deps: Partial<WakeLockDeps> = {}) {
		this.preference = preference;
		this.deps = { ...defaultWakeLockDeps, ...deps };
	}

	/** Backend that would be used right now. */
	get backend(): WakeLockBackend {
		const resolved = selectBackend({ preference: this.preference, platform: this.deps.platform });
		return resolved === "pmset" && this.pmsetBroken ? "caffeinate" : resolved;
	}

	status(): WakeLockStatus {
		const backend = this.pmsetEnabled ? "pmset" : this.caffeinate ? "caffeinate" : "none";
		return {
			backend,
			configured: this.backend,
			held: backend !== "none",
		};
	}

	/** Take the lock. Safe to call when it is already held. */
	acquire(): Promise<void> {
		return this.enqueue(() => this.acquireNow());
	}

	/** Drop the lock. Safe to call when nothing is held. */
	release(): Promise<void> {
		return this.enqueue(() => this.releaseNow());
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const next = this.pending.then(task, task);
		this.pending = next.catch(() => undefined);
		return this.pending;
	}

	private warn(key: string, message: string): void {
		if (this.warned.has(key)) return;
		this.warned.add(key);
		this.deps.warn?.(message);
	}

	private async acquireNow(): Promise<void> {
		const backend = this.backend;
		if (backend === "none") {
			await this.releaseNow();
			return;
		}
		if (backend === "caffeinate") {
			await this.disablePmset();
			this.startCaffeinate();
			return;
		}
		if (!this.pmsetEnabled) {
			const result = await this.deps.setDisableSleep(true);
			if (result.code !== 0) {
				this.pmsetBroken = true;
				this.warn(
					"pmset-enable",
					"night-mode: could not enable closed-lid wake lock with passwordless sudo " +
						`(${result.stderr.trim() || `exit ${result.code}`}). Falling back to caffeinate.`,
				);
				this.startCaffeinate();
				return;
			}
			this.pmsetEnabled = true;
		}
		this.startCaffeinate();
	}

	private async releaseNow(): Promise<void> {
		this.killCaffeinate();
		await this.disablePmset();
	}

	private async disablePmset(): Promise<void> {
		if (!this.pmsetEnabled) return;
		const result = await this.deps.setDisableSleep(false);
		if (result.code === 0) {
			this.pmsetEnabled = false;
			return;
		}
		this.warn(
			"pmset-disable",
			"night-mode: could not restore closed-lid sleep with passwordless sudo " +
				`(${result.stderr.trim() || `exit ${result.code}`}). Retrying on the next wake-lock sync.`,
		);
	}

	private startCaffeinate(): void {
		if (this.caffeinate) return;
		const child = this.deps.spawnCaffeinate();
		if (!child) return;
		const forget = () => {
			if (this.caffeinate === child) this.caffeinate = undefined;
		};
		child.on("error", forget);
		child.on("exit", forget);
		child.unref?.();
		this.caffeinate = child;
	}

	private killCaffeinate(): void {
		if (!this.caffeinate) return;
		try {
			this.caffeinate.kill();
		} catch {
			// already gone
		}
		this.caffeinate = undefined;
	}
}
