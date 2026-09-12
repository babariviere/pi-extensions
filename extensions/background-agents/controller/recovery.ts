import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { BackgroundAgentsDatabase, QueuedRecovery, TrustedCheckpoint } from "./database.ts";

const execFileAsync = promisify(execFile);

export type SystemdUnitState = "active" | "activating" | "deactivating" | "inactive" | "failed" | "unknown";
export type WorktreeState = "clean" | "dirty" | "missing" | "unknown";
export type RecoveryAction = "running" | "replaced" | "needs-human";

export interface SystemdInspector {
	inspect(unit: string): Promise<SystemdUnitState>;
}

export interface WorktreeInspection {
	state: WorktreeState;
	detail?: string;
}

export interface WorktreeInspector {
	inspect(path: string): Promise<WorktreeInspection>;
	quarantine(path: string, reason: string): Promise<string>;
}

export interface RecoveryOptions {
	owner: string;
	leaseMs?: number;
	now?: () => Date;
	systemd?: SystemdInspector;
	worktrees?: WorktreeInspector;
}

export interface RecoveryResult {
	attemptId: string;
	action: RecoveryAction;
	systemdState: SystemdUnitState;
	worktreeState?: WorktreeState;
	checkpoint?: TrustedCheckpoint;
	quarantinedPath?: string;
	replacement?: QueuedRecovery;
	reason: string;
}

const defaultSystemd: SystemdInspector = {
	async inspect(unit) {
		try {
			const { stdout } = await execFileAsync(
				"systemctl",
				["--user", "show", unit, "--property=ActiveState", "--value"],
				{
					shell: false,
				},
			);
			const state = stdout.trim();
			if (["active", "activating", "deactivating", "inactive", "failed"].includes(state))
				return state as SystemdUnitState;
			return "unknown";
		} catch {
			return "unknown";
		}
	},
};

const defaultWorktrees: WorktreeInspector = {
	async inspect(path) {
		if (!existsSync(path)) return { state: "missing" };
		try {
			const { stdout } = await execFileAsync("git", ["-C", path, "status", "--porcelain", "--untracked-files=all"], {
				shell: false,
			});
			return stdout.length === 0 ? { state: "clean" } : { state: "dirty", detail: stdout.slice(0, 4096) };
		} catch (error) {
			return { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
		}
	},
	async quarantine(path, reason) {
		if (!existsSync(path)) return path;
		const destination = join(
			dirname(path),
			`${path.split("/").pop() ?? "worktree"}.quarantine-${Date.now()}-${randomUUID()}`,
		);
		mkdirSync(dirname(destination), { recursive: true });
		renameSync(path, destination);
		void reason;
		return destination;
	},
};

function nowValue(now: () => Date | undefined): Date {
	const value = now() ?? new Date();
	if (Number.isNaN(value.getTime())) throw new Error("now must return a valid date");
	return value;
}

function attemptRow(
	database: BackgroundAgentsDatabase,
	attemptId: string,
):
	| {
			id: string;
			job_id: string;
			systemd_unit: string | null;
			worktree: string | null;
			state: string;
	  }
	| undefined {
	return database.get("SELECT id, job_id, systemd_unit, worktree, state FROM attempts WHERE id = ?", attemptId) as
		| {
				id: string;
				job_id: string;
				systemd_unit: string | null;
				worktree: string | null;
				state: string;
		  }
		| undefined;
}

export class RecoveryCoordinator {
	private readonly systemd: SystemdInspector;
	private readonly worktrees: WorktreeInspector;

	constructor(
		private readonly database: BackgroundAgentsDatabase,
		private readonly options: RecoveryOptions,
	) {
		if (!options.owner.trim()) throw new Error("owner must be a non-empty string");
		this.systemd = options.systemd ?? defaultSystemd;
		this.worktrees = options.worktrees ?? defaultWorktrees;
	}

	async reconcileAttempt(attemptId: string): Promise<RecoveryResult> {
		const attempt = attemptRow(this.database, attemptId);
		if (!attempt) throw new Error(`Unknown attempt: ${attemptId}`);
		if (attempt.state !== "running") {
			return {
				attemptId,
				action: "needs-human",
				systemdState: "unknown",
				reason: `attempt is already ${attempt.state}`,
			};
		}
		const recoveryTime = nowValue(this.options.now ?? (() => new Date()));

		let systemdState: SystemdUnitState = "unknown";
		let systemdError: unknown;
		if (attempt.systemd_unit) {
			try {
				systemdState = await this.systemd.inspect(attempt.systemd_unit);
			} catch (error) {
				systemdError = error;
			}
		}
		if (["active", "activating", "deactivating"].includes(systemdState)) {
			this.database.recordRecoveryDecision({
				attemptId,
				decision: "keep-running",
				reason: `systemd unit is ${systemdState}`,
				systemdState,
				createdAt: recoveryTime,
			});
			return { attemptId, action: "running", systemdState, reason: `systemd unit is ${systemdState}` };
		}

		let worktreeState: WorktreeState | undefined;
		let quarantinedPath: string | undefined;
		if (attempt.worktree) {
			let inspection: WorktreeInspection;
			try {
				inspection = await this.worktrees.inspect(attempt.worktree);
			} catch (error) {
				inspection = { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
			}
			worktreeState = inspection.state;
			this.database.recordRecoveryDecision({
				attemptId,
				decision: "observed",
				reason: inspection.detail ?? `worktree is ${inspection.state}`,
				systemdState,
				worktreeState,
				createdAt: recoveryTime,
			});
			if (worktreeState === "dirty") {
				try {
					quarantinedPath = await this.worktrees.quarantine(attempt.worktree, "dirty worktree during recovery");
					this.database.recordRecoveryDecision({
						attemptId,
						decision: "quarantine",
						reason: "dirty worktree preserved and quarantined",
						systemdState,
						worktreeState,
						metadata: { quarantinedPath },
						createdAt: recoveryTime,
					});
				} catch (error) {
					return this.needsHuman(
						attemptId,
						systemdState,
						worktreeState,
						"unable to quarantine dirty worktree",
						error,
						recoveryTime,
					);
				}
			}
		}

		if (systemdState === "unknown" || worktreeState === "unknown")
			return this.needsHuman(
				attemptId,
				systemdState,
				worktreeState,
				systemdError ? "unable to reconcile systemd state" : "systemd state is unknown",
				systemdError,
				recoveryTime,
			);
		const checkpoint = this.database.latestTrustedCheckpoint(attempt.job_id);
		if (!checkpoint)
			return this.needsHuman(
				attemptId,
				systemdState,
				worktreeState,
				"no trusted checkpoint is available",
				undefined,
				recoveryTime,
			);

		const replacement = this.database.queueReplacementAttempt(attemptId, checkpoint.id, recoveryTime);
		if (!replacement)
			return this.needsHuman(
				attemptId,
				systemdState,
				worktreeState,
				"attempt changed before replacement",
				undefined,
				recoveryTime,
			);
		this.database.recordRecoveryDecision({
			attemptId,
			decision: "replace-from-trusted-checkpoint",
			reason: "systemd is no longer running; replacement starts from the latest trusted checkpoint",
			systemdState,
			worktreeState,
			checkpointId: checkpoint.id,
			replacementAttemptId: replacement.attemptId,
			metadata: { ...(quarantinedPath ? { quarantinedPath } : {}), queued: true },
			createdAt: recoveryTime,
		});
		return {
			attemptId,
			action: "replaced",
			systemdState,
			worktreeState,
			checkpoint,
			quarantinedPath,
			replacement,
			reason: "replacement queued from trusted checkpoint",
		};
	}

	async recover(): Promise<RecoveryResult[]> {
		const attempts = this.database.all<{ id: string }>(
			"SELECT id FROM attempts WHERE state = 'running' ORDER BY started_at, id",
		);
		const results: RecoveryResult[] = [];
		for (const attempt of attempts) results.push(await this.reconcileAttempt(attempt.id));
		return results;
	}

	private needsHuman(
		attemptId: string,
		systemdState: SystemdUnitState,
		worktreeState: WorktreeState | undefined,
		reason: string,
		error?: unknown,
		createdAt = nowValue(this.options.now ?? (() => new Date())),
	): RecoveryResult {
		const detail = error instanceof Error ? `${reason}: ${error.message}` : reason;
		this.database.markAttemptNeedsHuman(attemptId, detail, createdAt);
		this.database.recordRecoveryDecision({
			attemptId,
			decision: "needs-human",
			reason: detail,
			systemdState,
			worktreeState,
			createdAt,
		});
		return { attemptId, action: "needs-human", systemdState, worktreeState, reason: detail };
	}
}

export const DurableRecoveryCoordinator = RecoveryCoordinator;
export function createRecoveryCoordinator(
	database: BackgroundAgentsDatabase,
	options: RecoveryOptions,
): RecoveryCoordinator {
	return new RecoveryCoordinator(database, options);
}
