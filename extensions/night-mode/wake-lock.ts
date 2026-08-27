/**
 * Wake lock for night-mode: keeps the machine awake while an overnight run is
 * in flight.
 *
 * Two backends:
 *
 *  - `caffeinate`: a held `caffeinate -dimsu` child process. Always available on
 *    macOS, dies with pi (so a crash never leaves the machine awake), but does
 *    *not* survive closing the lid. Lid close triggers clamshell sleep, which
 *    overrides power assertions.
 *  - `amphetamine`: an Amphetamine session driven over AppleScript. Honours
 *    Amphetamine's closed-display mode, so the run survives a closed lid, but
 *    only if "Allow system sleep when display is closed" is *unchecked* in
 *    Amphetamine -> Settings -> Session Defaults. Closed-display mode is not
 *    settable per session, so that preference is what actually governs.
 *
 * Amphetamine sessions are fire and forget: they outlive the process that
 * started them. A crashed pi must not leave the Mac awake until morning, so
 * sessions are always bounded (`SESSION_MINUTES`) and re-armed from the
 * night-mode tick. A crash then self-heals within one session length.
 *
 * The pure parts (backend selection, script building, output parsing, renewal
 * math) are exported separately so they can be tested without a Mac.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";

/** Which mechanism is actually holding sleep off. */
export type WakeLockBackend = "amphetamine" | "caffeinate" | "none";

/** User preference, from `nightMode.wakeLock` in settings. */
export type WakeLockPreference = "auto" | "amphetamine" | "caffeinate" | "off";

export const WAKE_LOCK_PREFERENCES: readonly WakeLockPreference[] = [
	"auto",
	"amphetamine",
	"caffeinate",
	"off",
];

/** Narrow an untrusted settings value to a wake lock preference. */
export function isWakeLockPreference(value: unknown): value is WakeLockPreference {
	return (
		typeof value === "string" &&
		(WAKE_LOCK_PREFERENCES as readonly string[]).includes(value)
	);
}

/** Where the App Store puts Amphetamine. */
export const AMPHETAMINE_APP_PATHS = [
	"/Applications/Amphetamine.app",
	"/System/Applications/Amphetamine.app",
];

/**
 * Length of a single Amphetamine session. Short enough that a crashed pi lets
 * the machine sleep the same night, long enough that a missed tick (a suspended
 * laptop, a slow osascript) does not drop the lock mid-run.
 */
export const SESSION_MINUTES = 30;

/** Re-arm once less than this is left on the current session. */
export const RENEW_MARGIN_MS = 10 * 60_000;

/** Ask Amphetamine whether the session is still there at most this often. */
export const VERIFY_INTERVAL_MS = 5 * 60_000;

/**
 * Resolve the backend to use. `auto` prefers Amphetamine when it is installed,
 * since it is the only one of the two that survives a closed lid.
 */
export function selectBackend(input: {
	preference: WakeLockPreference;
	platform: string;
	amphetamineInstalled: boolean;
}): WakeLockBackend {
	if (input.preference === "off") return "none";
	if (input.platform !== "darwin") return "none";
	if (input.preference === "caffeinate") return "caffeinate";
	if (input.preference === "amphetamine") return "amphetamine";
	return input.amphetamineInstalled ? "amphetamine" : "caffeinate";
}

/**
 * AppleScript that starts (or replaces) a bounded Amphetamine session.
 *
 * `interval` is an unquoted enum token in Amphetamine's dictionary
 * (`{duration:3, interval:hours, ...}`). Quoting it fails at runtime with a
 * useless `AppleEvent handler failed (-10000)`, so leave it bare.
 */
export function startSessionScript(minutes: number = SESSION_MINUTES): string {
	const safe = Math.max(1, Math.floor(minutes));
	return (
		'tell application "Amphetamine" to start new session with options ' +
		`{duration:${safe}, interval:minutes, displaySleepAllowed:false}`
	);
}

/** AppleScript that ends whatever session is running. */
export const END_SESSION_SCRIPT =
	'tell application "Amphetamine" to end session';

/** AppleScript that reports whether a session is running. */
export const SESSION_ACTIVE_SCRIPT =
	'tell application "Amphetamine" to return session is active';

/**
 * AppleScript that reports whether the session survives a closed lid. Inverted
 * from the checkbox: `true` here means the UI's "Allow system sleep when display
 * is closed" is *off*, which is the state an overnight run wants.
 */
export const CLOSED_DISPLAY_MODE_SCRIPT =
	'tell application "Amphetamine" to return closed display mode enabled';

/** Read the boolean `osascript` prints for `session is active`. */
export function parseSessionActive(stdout: string): boolean {
	return stdout.trim().toLowerCase() === "true";
}

/**
 * True when the current session is close enough to expiry to be re-armed.
 * An unknown expiry means nothing is held, which also needs a start.
 */
export function shouldRenew(
	expiresAt: number | undefined,
	now: number,
	marginMs: number = RENEW_MARGIN_MS,
): boolean {
	if (expiresAt === undefined) return true;
	return expiresAt - now <= marginMs;
}

/**
 * `osascript` failures that mean "this will never work in this session", so the
 * lock should fall back to `caffeinate` instead of retrying every 30s.
 */
export function isPermanentFailure(stderr: string): boolean {
	const text = stderr.toLowerCase();
	return (
		text.includes("not authorized") ||
		text.includes("-1743") ||
		text.includes("can\u2019t find application") ||
		text.includes("can't find application") ||
		text.includes("-1728")
	);
}

export interface ScriptResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Everything the lock touches outside itself, so tests can fake it. */
export interface WakeLockDeps {
	platform: string;
	/** Runs an AppleScript and resolves with its result. Never rejects. */
	runScript: (script: string) => Promise<ScriptResult>;
	/** Spawns a detached `caffeinate`, or `undefined` when it could not start. */
	spawnCaffeinate: () => ChildProcess | undefined;
	amphetamineInstalled: () => boolean;
	now: () => number;
	/** Reported to the user for a degraded fallback. Once per reason. */
	warn?: (message: string) => void;
}

function runScript(script: string): Promise<ScriptResult> {
	return new Promise((resolve) => {
		try {
			const child = spawn("osascript", ["-e", script], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.on("error", (error) => {
				resolve({ code: -1, stdout: "", stderr: String(error) });
			});
			child.on("close", (code) => {
				resolve({ code: code ?? -1, stdout, stderr });
			});
		} catch (error) {
			resolve({ code: -1, stdout: "", stderr: String(error) });
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
	runScript,
	spawnCaffeinate,
	amphetamineInstalled: () => AMPHETAMINE_APP_PATHS.some((p) => existsSync(p)),
	now: () => Date.now(),
};

export interface WakeLockStatus {
	/** Backend currently holding the lock, `"none"` when nothing is held. */
	backend: WakeLockBackend;
	held: boolean;
	/** Backend that would be used, whether or not the lock is held. */
	configured: WakeLockBackend;
	/** Epoch ms the Amphetamine session lapses, when one is held. */
	expiresAt?: number;
}

/**
 * Holds sleep off for as long as `acquire` keeps being called, and lets go on
 * `release`. Both are idempotent, so callers can just mirror their own state
 * into it on every tick.
 */
export class WakeLock {
	private readonly deps: WakeLockDeps;
	private readonly preference: WakeLockPreference;
	/** Set once Amphetamine has proven unusable, pinning the lock to caffeinate. */
	private amphetamineBroken = false;
	private caffeinate: ChildProcess | undefined;
	private sessionExpiresAt: number | undefined;
	private lastVerifiedAt = 0;
	/** Serialises AppleScript calls so a slow tick cannot interleave them. */
	private pending: Promise<void> = Promise.resolve();
	private warned = new Set<string>();

	constructor(
		preference: WakeLockPreference = "auto",
		deps: Partial<WakeLockDeps> = {},
	) {
		this.preference = preference;
		this.deps = { ...defaultWakeLockDeps, ...deps };
	}

	/** Backend that would be used right now. */
	get backend(): WakeLockBackend {
		const resolved = selectBackend({
			preference: this.preference,
			platform: this.deps.platform,
			amphetamineInstalled: this.deps.amphetamineInstalled(),
		});
		if (resolved === "amphetamine" && this.amphetamineBroken) return "caffeinate";
		return resolved;
	}

	status(): WakeLockStatus {
		const held = this.caffeinate !== undefined || this.sessionExpiresAt !== undefined;
		return {
			backend: held
				? this.caffeinate
					? "caffeinate"
					: "amphetamine"
				: "none",
			configured: this.backend,
			held,
			expiresAt: this.sessionExpiresAt,
		};
	}

	/** Take the lock, or renew it when it is already held. Safe to spam. */
	acquire(): Promise<void> {
		return this.enqueue(() => this.acquireNow());
	}

	/** Drop the lock. Safe to call when nothing is held. */
	release(): Promise<void> {
		return this.enqueue(() => this.releaseNow());
	}

	/** Best-effort synchronous teardown, for `session_shutdown`. */
	releaseSync(): void {
		this.killCaffeinate();
		if (this.sessionExpiresAt !== undefined) {
			this.sessionExpiresAt = undefined;
			void this.deps.runScript(END_SESSION_SCRIPT);
		}
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
			await this.endSession();
			this.startCaffeinate();
			return;
		}
		this.killCaffeinate();
		await this.armSession();
	}

	private async releaseNow(): Promise<void> {
		this.killCaffeinate();
		await this.endSession();
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

	private async endSession(): Promise<void> {
		if (this.sessionExpiresAt === undefined) return;
		this.sessionExpiresAt = undefined;
		await this.deps.runScript(END_SESSION_SCRIPT);
	}

	/**
	 * Warn when the session would let the machine sleep on a closed lid, which is
	 * the whole reason to prefer Amphetamine. Not fixed automatically: Amphetamine
	 * shows a modal the first time closed-display mode is enabled, and a modal is
	 * the last thing an unattended run needs.
	 */
	private async checkClosedDisplayMode(): Promise<void> {
		const probe = await this.deps.runScript(CLOSED_DISPLAY_MODE_SCRIPT);
		if (probe.code !== 0 || parseSessionActive(probe.stdout)) return;
		this.warn(
			"closed-display",
			"night-mode: Amphetamine will let this Mac sleep when the lid is closed. " +
				"Uncheck Amphetamine \u2192 Settings \u2192 Session Defaults \u2192 " +
				"\u201cAllow system sleep when display is closed\u201d to keep overnight runs " +
				"alive with the lid shut (AC power recommended).",
		);
	}

	/**
	 * Start a session, or re-arm one that is about to lapse. Also re-arms when
	 * Amphetamine says no session is running, which happens when the user or an
	 * Amphetamine trigger killed it behind our back.
	 */
	private async armSession(): Promise<void> {
		const now = this.deps.now();
		let renew = shouldRenew(this.sessionExpiresAt, now);
		if (!renew && now - this.lastVerifiedAt >= VERIFY_INTERVAL_MS) {
			this.lastVerifiedAt = now;
			const probe = await this.deps.runScript(SESSION_ACTIVE_SCRIPT);
			if (probe.code === 0 && !parseSessionActive(probe.stdout)) renew = true;
		}
		if (!renew) return;

		const result = await this.deps.runScript(startSessionScript());
		if (result.code === 0) {
			this.sessionExpiresAt = this.deps.now() + SESSION_MINUTES * 60_000;
			this.lastVerifiedAt = this.deps.now();
			await this.checkClosedDisplayMode();
			return;
		}

		this.sessionExpiresAt = undefined;
		if (isPermanentFailure(result.stderr)) {
			this.amphetamineBroken = true;
			this.warn(
				"amphetamine-broken",
				"night-mode: Amphetamine is not scriptable (enable \u201cAllow AppleScript/Automation\u201d " +
					"in its settings and approve the prompt). Falling back to caffeinate, " +
					"which does not survive closing the lid.",
			);
		} else {
			this.warn(
				"amphetamine-failed",
				`night-mode: could not start an Amphetamine session (${result.stderr.trim() || `exit ${result.code}`}). Using caffeinate for now.`,
			);
		}
		this.startCaffeinate();
	}
}
