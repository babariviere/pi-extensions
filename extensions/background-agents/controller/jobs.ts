import type { BackgroundAgentsDatabase, JobClaim, JobInput } from "./database.ts";
import type { AttemptState } from "../types.ts";

const TERMINAL_ATTEMPT_STATES: readonly AttemptState[] = ["succeeded", "failed", "cancelled", "paused", "needs-human"];

export interface JobSchedulerOptions {
	emergencyStop?: boolean;
}

export interface FinishedAttempt {
	attemptId: string;
	state: AttemptState;
	failure?: string;
	now?: Date;
}

export class JobScheduler {
	private stopped: boolean;

	constructor(
		private readonly database: BackgroundAgentsDatabase,
		options: JobSchedulerOptions = {},
	) {
		this.stopped = database.isEmergencyStop() || options.emergencyStop === true;
	}

	get emergencyStop(): boolean {
		return this.stopped || this.database.isEmergencyStop();
	}

	setEmergencyStop(enabled: boolean, actor = "system"): void {
		this.stopped = enabled;
		this.database.setEmergencyStop(enabled, actor);
	}

	queueJob(input: JobInput): string {
		if (input.workItemId) {
			const item = this.database.get<{ case_id: string }>(
				"SELECT case_id FROM work_items WHERE id = ?",
				input.workItemId,
			);
			if (!item) throw new Error(`Unknown work item: ${input.workItemId}`);
			if (item.case_id !== input.caseId) throw new Error("work item belongs to another case");
		}
		return this.database.createJob(input);
	}

	claimNext(
		owner: string,
		leaseMs?: number,
		now = new Date(),
		assignment?: { profileId?: string; model?: string },
	): JobClaim | null {
		if (this.emergencyStop) return null;
		const candidates = this.database.all<{ id: string }>(
			`SELECT j.id
			 FROM jobs j
			 JOIN cases c ON c.id = j.case_id
			 LEFT JOIN work_items wi ON wi.id = j.work_item_id
			 LEFT JOIN work_items parent ON parent.id = wi.parent_id
			 WHERE j.state = 'queued'
			   AND c.state NOT IN ('paused', 'paused-usage', 'blocked', 'handled', 'cancelled')
			   AND (wi.id IS NULL OR wi.state IN ('queued', 'implementation', 'verification'))
			   AND (wi.id IS NULL OR wi.parent_id IS NULL OR parent.state = 'verified')
			 ORDER BY j.priority DESC, j.created_at ASC, j.id ASC`,
		);
		for (const candidate of candidates) {
			if (this.emergencyStop) return null;
			const claim = this.database.claimJob(candidate.id, owner, leaseMs, now, assignment);
			if (claim) return claim;
		}
		return null;
	}

	claim(
		jobId: string,
		owner: string,
		leaseMs?: number,
		now = new Date(),
		assignment?: { profileId?: string; model?: string },
	): JobClaim | null {
		if (this.emergencyStop) return null;
		if (
			this.database.get<{ role: string }>("SELECT role FROM jobs WHERE id = ?", jobId)?.role === "worker" &&
			!this.database.workerDispatchAllowed(jobId)
		)
			return null;
		const candidate = this.database.get<{ id: string }>(
			`SELECT j.id
			 FROM jobs j
			 JOIN cases c ON c.id = j.case_id
			 LEFT JOIN work_items wi ON wi.id = j.work_item_id
			 LEFT JOIN work_items parent ON parent.id = wi.parent_id
			 WHERE j.id = ?
			   AND j.state IN ('queued', 'running')
			   AND c.state NOT IN ('paused', 'paused-usage', 'blocked', 'handled', 'cancelled')
			   AND (wi.id IS NULL OR wi.state IN ('queued', 'implementation', 'verification'))
			   AND (wi.id IS NULL OR wi.parent_id IS NULL OR parent.state = 'verified')`,
			jobId,
		);
		if (!candidate) return null;
		return this.database.claimJob(jobId, owner, leaseMs, now, assignment);
	}

	renewLease(attemptId: string, owner: string, leaseMs?: number, now = new Date()): boolean {
		return this.database.renewLease(attemptId, owner, leaseMs, now);
	}

	finishAttempt(input: FinishedAttempt, owner: string): boolean {
		if (!TERMINAL_ATTEMPT_STATES.includes(input.state))
			throw new Error(`Attempt state is not terminal: ${input.state}`);
		const now = input.now ?? new Date();
		const finishedAt = now.toISOString();
		return this.database.withTransaction(() => {
			const attempt = this.database.get<{ job_id: string; profile_id?: string; state: AttemptState }>(
				"SELECT job_id, profile_id, state FROM attempts WHERE id = ?",
				input.attemptId,
			);
			if (!attempt) throw new Error(`Unknown attempt: ${input.attemptId}`);
			if (attempt.state !== "running") return false;
			const lease = this.database.get<{ owner: string; expires_at: string }>(
				"SELECT owner, expires_at FROM attempt_leases WHERE attempt_id = ?",
				input.attemptId,
			);
			if (!lease || lease.owner !== owner || lease.expires_at <= finishedAt) return false;
			const changed = this.database.run(
				"UPDATE attempts SET state = ?, failure = ?, finished_at = ? WHERE id = ? AND state = 'running'",
				input.state,
				input.failure ?? null,
				finishedAt,
				input.attemptId,
			);
			if (changed.changes !== 1) return false;
			this.database.run(
				"UPDATE jobs SET state = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND state = 'running'",
				input.state,
				finishedAt,
				attempt.job_id,
			);
			this.database.run("DELETE FROM attempt_leases WHERE attempt_id = ?", input.attemptId);
			this.database.run(
				"UPDATE emergency_stop_attempts SET systemd_confirmed = 1, reconciled = 1, updated_at = ? WHERE attempt_id = ? AND systemd_confirmed = 0 AND (SELECT systemd_unit FROM attempts WHERE id = ?) IS NULL",
				finishedAt,
				input.attemptId,
				input.attemptId,
			);
			if (attempt.profile_id) this.database.refreshProviderProfileActivity(attempt.profile_id, now);
			return true;
		});
	}

	reconcileExpiredLeases(now = new Date()): number {
		const timestamp = now.toISOString();
		return this.database.withTransaction(() => {
			const expired = this.database.all<{ attempt_id: string; job_id: string; profile_id?: string }>(
				"SELECT l.attempt_id, a.job_id, a.profile_id FROM attempt_leases l JOIN attempts a ON a.id = l.attempt_id WHERE l.expires_at <= ?",
				timestamp,
			);
			for (const lease of expired) {
				this.database.run(
					"UPDATE attempts SET state = 'failed', failure = ?, finished_at = ? WHERE id = ? AND state = 'running'",
					"lease expired",
					timestamp,
					lease.attempt_id,
				);
				this.database.run(
					"UPDATE jobs SET state = 'queued', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND state = 'running'",
					timestamp,
					lease.job_id,
				);
				this.database.run("DELETE FROM attempt_leases WHERE attempt_id = ?", lease.attempt_id);
				if (lease.profile_id) this.database.refreshProviderProfileActivity(lease.profile_id, now);
			}
			return expired.length;
		});
	}

	retryJob(jobId: string): boolean {
		const changed = this.database.run(
			"UPDATE jobs SET state = 'queued', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND state IN ('failed', 'needs-human', 'paused')",
			new Date().toISOString(),
			jobId,
		);
		return changed.changes === 1;
	}

	pauseCaseJobs(caseId: string): number {
		return this.database.withTransaction(() => {
			const now = new Date().toISOString();
			this.database.run(
				"UPDATE attempts SET state = 'paused', finished_at = ? WHERE job_id IN (SELECT id FROM jobs WHERE case_id = ?) AND state = 'running'",
				now,
				caseId,
			);
			this.database.run(
				"DELETE FROM attempt_leases WHERE attempt_id IN (SELECT a.id FROM attempts a JOIN jobs j ON j.id = a.job_id WHERE j.case_id = ?)",
				caseId,
			);
			this.database.run(
				"UPDATE provider_profile_state SET active_attempts = (SELECT count(*) FROM attempts WHERE profile_id = provider_profile_state.profile_id AND state = 'running') WHERE profile_id IN (SELECT DISTINCT profile_id FROM attempts WHERE job_id IN (SELECT id FROM jobs WHERE case_id = ?) AND profile_id IS NOT NULL)",
				caseId,
			);
			const changed = this.database.run(
				"UPDATE jobs SET state = 'paused', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE case_id = ? AND state IN ('queued', 'running')",
				now,
				caseId,
			);
			return changed.changes;
		});
	}

	resumeCaseJobs(caseId: string): number {
		const changed = this.database.run(
			"UPDATE jobs SET state = 'queued', updated_at = ? WHERE case_id = ? AND state = 'paused'",
			new Date().toISOString(),
			caseId,
		);
		return changed.changes;
	}

	/** Stop a model run without reviving or replacing the running attempt. */
	pauseAttemptForUsage(attemptId: string, reason = "provider usage unavailable", now = new Date()): boolean {
		if (this.database.get<{ role: string }>("SELECT role FROM attempts WHERE id = ?", attemptId)?.role === "verifier")
			return false;
		return this.database.pauseJobForUsage(attemptId, reason, now);
	}

	resumeUsageJob(jobId: string): boolean {
		const job = this.database.get<{ case_id: string }>("SELECT case_id FROM jobs WHERE id = ?", jobId);
		if (!job) return false;
		return this.database.resumeUsageJobs(job.case_id) > 0;
	}

	cancelCaseJobs(caseId: string): number {
		return this.database.withTransaction(() => {
			const now = new Date().toISOString();
			this.database.run(
				"UPDATE attempts SET state = 'cancelled', finished_at = ?, failure = ? WHERE job_id IN (SELECT id FROM jobs WHERE case_id = ?) AND state IN ('queued', 'running', 'paused')",
				now,
				"case cancelled",
				caseId,
			);
			this.database.run(
				"DELETE FROM attempt_leases WHERE attempt_id IN (SELECT a.id FROM attempts a JOIN jobs j ON j.id = a.job_id WHERE j.case_id = ?)",
				caseId,
			);
			this.database.run(
				"UPDATE provider_profile_state SET active_attempts = (SELECT count(*) FROM attempts WHERE profile_id = provider_profile_state.profile_id AND state = 'running') WHERE profile_id IN (SELECT DISTINCT profile_id FROM attempts WHERE job_id IN (SELECT id FROM jobs WHERE case_id = ?) AND profile_id IS NOT NULL)",
				caseId,
			);
			const changed = this.database.run(
				"UPDATE jobs SET state = 'cancelled', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE case_id = ? AND state NOT IN ('succeeded', 'cancelled')",
				now,
				caseId,
			);
			return changed.changes;
		});
	}
}

export const DurableJobScheduler = JobScheduler;

export function createJobScheduler(database: BackgroundAgentsDatabase, options?: JobSchedulerOptions): JobScheduler {
	return new JobScheduler(database, options);
}
