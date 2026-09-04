/**
 * The Seatbelt (macOS `sandbox-exec`) sandbox backend.
 *
 * Owns one temp profile per instance: `initialize()` builds the SBPL text
 * (`seatbelt-profile.ts`), writes it to a private `mkdtemp` directory, and
 * runs a real `sandbox-exec` self-test before trusting it, so a malformed or
 * over-tight profile fails loudly at session start rather than on the tenth
 * `pi.bash` of the night. `reset()` removes the directory; a
 * `process.once("exit")` handler is a best-effort backstop for a crash.
 *
 * `-f <file>` rather than Codex's `-p <text>`: `wrapWithSandbox` has to
 * return a shell command *string* for `supervisedSpawn` to feed to
 * `bash -c`, and a multi-kilobyte inline policy in a single shell word is
 * fragile. `-f` also gives `reset()` something real to clean up.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SandboxPolicy } from "./policy.ts";
import { buildSeatbeltProfile, type SeatbeltProfile } from "./seatbelt-profile.ts";
import { resolveShellPath, shellQuote } from "./shell.ts";

const execFileAsync = promisify(execFile);

/**
 * Only `/usr/bin/sandbox-exec` is ever run: a PATH-resolved `sandbox-exec`
 * could be shadowed by anything, and if `/usr/bin` itself were compromised
 * the attacker would already have root.
 */
export const SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";

const activeProfileDirs = new Set<string>();
let exitHandlerRegistered = false;

function ensureExitCleanupRegistered(): void {
	if (exitHandlerRegistered) return;
	exitHandlerRegistered = true;
	process.once("exit", () => {
		for (const dir of activeProfileDirs) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best effort: the process is exiting anyway.
			}
		}
	});
}

export class SeatbeltSandbox {
	#shellPath: string;
	#platform: NodeJS.Platform;
	#buildProfile: (policy: SandboxPolicy) => SeatbeltProfile;
	#dir: string | undefined;
	#profilePath: string | undefined;
	#params: Array<[string, string]> = [];
	/** Roots that were canonicalized (a symlinked root) or dropped, from the last build. */
	warnings: string[] = [];

	/**
	 * `platform` and `buildProfile` are test seams: injecting them lets
	 * `manager.test.ts` exercise the platform guard and the self-test's
	 * failure path without mutating global `process.platform` or hand-editing
	 * a profile file on disk.
	 */
	constructor(
		shellPath: string = resolveShellPath(),
		platform: NodeJS.Platform = process.platform,
		buildProfile: (policy: SandboxPolicy) => SeatbeltProfile = buildSeatbeltProfile,
	) {
		this.#shellPath = shellPath;
		this.#platform = platform;
		this.#buildProfile = buildProfile;
	}

	async initialize(policy: SandboxPolicy): Promise<void> {
		if (this.#platform !== "darwin") {
			throw new Error(
				`sandbox: OS enforcement requires macOS (this is darwin-only); platform is ${this.#platform}. ` +
					'Set spindle.json sandbox.mode to "off" to run unsandboxed.',
			);
		}
		if (!existsSync(SEATBELT_EXECUTABLE)) {
			throw new Error(
				`sandbox: ${SEATBELT_EXECUTABLE} not found; seatbelt enforcement is unavailable on this machine.`,
			);
		}

		const built = this.#buildProfile(policy);
		this.warnings = built.warnings;
		this.#params = built.params;

		const dir = mkdtempSync(join(tmpdir(), "pi-spindle-sbx-"));
		// Registered for cleanup immediately, before anything is written into it:
		// a writeFileSync failure below must not leak this directory.
		activeProfileDirs.add(dir);
		ensureExitCleanupRegistered();
		this.#dir = dir;

		const profilePath = join(dir, "profile.sb");
		try {
			writeFileSync(profilePath, built.profile, { mode: 0o600 });
		} catch (error) {
			this.#removeDir();
			throw error;
		}
		this.#profilePath = profilePath;

		// Self-test: a real sandbox-exec round trip before this profile is ever
		// trusted for a real command. This is what turns "malformed SBPL" into
		// "the session refuses to start" instead of "every pi.bash mysteriously
		// fails all night", and it also proves the configured shell can exec and
		// map its own dylibs (see seatbelt-profile.ts on file-map-executable).
		try {
			const { stderr } = await execFileAsync(SEATBELT_EXECUTABLE, this.#sandboxExecArgs("exit 0"));
			if (stderr?.trim()) throw new Error(stderr.trim());
		} catch (error) {
			this.#removeDir();
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`sandbox: seatbelt profile rejected by sandbox-exec: ${message}`);
		}
	}

	async wrapWithSandbox(command: string): Promise<string> {
		if (!this.#profilePath) throw new Error("sandbox: seatbelt profile not initialized");
		return [SEATBELT_EXECUTABLE, ...this.#sandboxExecArgs(command)].map(shellQuote).join(" ");
	}

	async reset(): Promise<void> {
		this.#removeDir();
	}

	/** `-f <profile> -D<KEY>=<VALUE> ... -- <shell> -c <command>`, as a raw argv array. */
	#sandboxExecArgs(command: string): string[] {
		if (!this.#profilePath) throw new Error("sandbox: seatbelt profile not initialized");
		const params = this.#params.map(([key, value]) => `-D${key}=${value}`);
		return ["-f", this.#profilePath, ...params, "--", this.#shellPath, "-c", command];
	}

	#removeDir(): void {
		const dir = this.#dir;
		this.#dir = undefined;
		this.#profilePath = undefined;
		if (!dir) return;
		activeProfileDirs.delete(dir);
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best effort: a stale profile is dropped when the process exits.
		}
	}
}
