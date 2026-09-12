import type { BackgroundAgentsConfig, AgentRole, ProviderKind, ProviderProfile } from "../../types.ts";
import type { BackgroundAgentsDatabase, JobClaim } from "../database.ts";
import { JobScheduler } from "../jobs.ts";
import { ProfileUsageController, type ProfileUsageControllerOptions } from "./usage.ts";

export type SchedulingClass = "cheap" | "expensive";

export interface ProviderSelection {
	profile: ProviderProfile;
	model?: string;
	provider: ProviderKind;
	kind: SchedulingClass;
}

export interface ProviderSchedulerOptions {
	usage?: ProfileUsageController;
	usageOptions?: ProfileUsageControllerOptions;
	jobScheduler?: JobScheduler;
	emergencyStop?: boolean;
	leaseMs?: number;
	clock?: { now(): Date } | (() => Date);
}

function nowFrom(clock: ProviderSchedulerOptions["clock"]): Date {
	return new Date(typeof clock === "function" ? clock().getTime() : (clock?.now().getTime() ?? Date.now()));
}

function schedulingClass(role: AgentRole): SchedulingClass {
	return role === "classifier" || role === "investigator" ? "cheap" : "expensive";
}

function roleIsAllowed(profile: ProviderProfile, role: AgentRole): boolean {
	return profile.allowedRoles.includes(role);
}

/** Provider-aware durable job claiming. It only assigns queued jobs and never retargets a running attempt. */
export class ProviderScheduler {
	readonly usage: ProfileUsageController;
	private readonly jobs: JobScheduler;
	private readonly clock: ProviderSchedulerOptions["clock"];
	private readonly defaultLeaseMs: number;

	constructor(
		private readonly database: BackgroundAgentsDatabase,
		private readonly config: BackgroundAgentsConfig,
		options: ProviderSchedulerOptions = {},
	) {
		this.clock = options.clock;
		this.defaultLeaseMs = options.leaseMs ?? 30_000;
		this.jobs = options.jobScheduler ?? new JobScheduler(database, { emergencyStop: options.emergencyStop });
		this.usage = options.usage ?? new ProfileUsageController(database, config.profiles, options.usageOptions);
		for (const profile of config.profiles) {
			if (database.get("SELECT profile_id FROM provider_profile_state WHERE profile_id = ?", profile.id)) continue;
			database.upsertProviderProfileState({
				profileId: profile.id,
				concurrencyLimit: profile.maxBackgroundAttempts,
				interactiveReserve: profile.interactiveReserve,
			});
		}
	}

	get emergencyStop(): boolean {
		return this.jobs.emergencyStop;
	}

	setEmergencyStop(enabled: boolean, actor = "system"): void {
		this.jobs.setEmergencyStop(enabled, actor);
	}

	private activeAttempts(profileId: string): number {
		const row = this.database.get<{ count: number }>(
			"SELECT count(*) AS count FROM attempts WHERE profile_id = ? AND state = 'running'",
			profileId,
		);
		return Number(row?.count ?? 0);
	}

	private previousProvider(jobId: string): ProviderKind | undefined {
		const row = this.database.get<{ profile_id: string }>(
			`SELECT p.profile_id
			 FROM attempts a
			 JOIN jobs j ON j.id = a.job_id
			 JOIN provider_profile_state p ON p.profile_id = a.profile_id
			 WHERE j.case_id = (SELECT case_id FROM jobs WHERE id = ?)
			   AND a.role <> 'verifier'
			 ORDER BY a.generation DESC, a.created_at DESC LIMIT 1`,
			jobId,
		);
		return row ? this.config.profiles.find((profile) => profile.id === row.profile_id)?.provider : undefined;
	}

	private jobRole(jobId: string): AgentRole {
		const row = this.database.get<{ role: AgentRole }>("SELECT role FROM jobs WHERE id = ?", jobId);
		if (!row) throw new Error(`Unknown job: ${jobId}`);
		return row.role;
	}

	private questionAttemptAvailable(jobId: string): boolean {
		const job = this.database.get<{ role: AgentRole; case_id: string }>(
			"SELECT j.role, j.case_id FROM jobs j WHERE j.id = ?",
			jobId,
		);
		if (!job || job.role !== "investigator") return true;
		const state = this.database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", job.case_id)?.state;
		if (state !== "question-analysis") return true;
		const attempts = Number(
			this.database.get<{ count: number }>("SELECT count(*) AS count FROM attempts WHERE job_id = ?", jobId)
				?.count ?? 0,
		);
		return attempts < this.config.question.maxAttempts;
	}

	selectProfile(jobId: string, now = nowFrom(this.clock)): ProviderSelection | null {
		const role = this.jobRole(jobId);
		const kind = schedulingClass(role);
		const alternate = role === "verifier" ? this.previousProvider(jobId) : undefined;
		const candidates = this.config.profiles
			.filter((profile) => roleIsAllowed(profile, role))
			.filter((profile) => this.activeAttempts(profile.id) < profile.maxBackgroundAttempts)
			.filter((profile) => this.usage.canSchedule(profile, role, now))
			.sort((left, right) => {
				if (alternate) return Number(left.provider === alternate) - Number(right.provider === alternate);
				return this.config.profiles.indexOf(left) - this.config.profiles.indexOf(right);
			});
		const profile = candidates[0];
		if (!profile) return null;
		return {
			profile,
			provider: profile.provider,
			kind,
			...(profile.allowedModels[0] ? { model: profile.allowedModels[0] } : {}),
		};
	}

	claim(jobId: string, owner: string, leaseMs = this.defaultLeaseMs, now = nowFrom(this.clock)): JobClaim | null {
		if (this.emergencyStop) return null;
		if (!this.questionAttemptAvailable(jobId)) return null;
		if (
			this.database.get<{ role: string }>("SELECT role FROM jobs WHERE id = ?", jobId)?.role === "worker" &&
			!this.database.workerDispatchAllowed(jobId)
		)
			return null;
		const selection = this.selectProfile(jobId, now);
		if (!selection) return null;
		const claim = this.jobs.claim(jobId, owner, leaseMs, now, {
			profileId: selection.profile.id,
			model: selection.model,
		});
		return claim
			? {
					...claim,
					profileId: selection.profile.id,
					...(selection.model ? { model: selection.model } : {}),
				}
			: null;
	}

	claimNext(owner: string, leaseMs = this.defaultLeaseMs, now = nowFrom(this.clock)): JobClaim | null {
		if (this.emergencyStop) return null;
		const candidates = this.database.all<{ id: string }>(
			`SELECT j.id FROM jobs j JOIN cases c ON c.id = j.case_id
			 WHERE j.state = 'queued' AND c.state NOT IN ('paused', 'paused-usage', 'blocked', 'handled', 'cancelled')
			 ORDER BY j.priority DESC, j.created_at ASC, j.id ASC`,
		);
		for (const candidate of candidates) {
			const claim = this.claim(candidate.id, owner, leaseMs, now);
			if (claim) return claim;
		}
		return null;
	}

	/** Pause an exhausted run. The next generation is created only after explicit resumption. */
	pauseForUsage(attemptId: string, reason = "provider usage unavailable", now = nowFrom(this.clock)): boolean {
		return this.jobs.pauseAttemptForUsage(attemptId, reason, now);
	}

	resumeAfterUsage(jobId: string): boolean {
		return this.jobs.resumeUsageJob(jobId);
	}

	/** Resume only usage-paused jobs after every one has a fresh schedulable profile. */
	resumeAfterUsageCase(caseId: string, now = nowFrom(this.clock)): number {
		const paused = this.database.usagePausedJobs(caseId);
		if (paused.length === 0) throw new Error(`Case ${caseId} has no jobs paused by usage`);
		for (const job of paused) {
			if (!this.selectProfile(job.jobId, now))
				throw new Error(`No fresh schedulable provider profile for ${job.jobId}`);
		}
		return this.database.resumeUsageJobs(caseId, now);
	}
}

export const ProviderAwareScheduler = ProviderScheduler;
export const classifySchedulingCost = schedulingClass;
