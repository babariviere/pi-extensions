import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BackgroundAgentsDatabase } from "../database.ts";
import type { AgentRole, ProviderProfile } from "../../types.ts";
import { fetchUsageSnapshot, isOAuthToken } from "../../../usage/source.ts";
import type { RateWindow, UsageProvider, UsageSnapshot } from "../../../usage/protocol.ts";

export interface ProfileUsageSnapshot {
	profileId: string;
	provider: UsageProvider;
	observedAt: Date | string;
	windows: RateWindow[];
	available?: boolean;
	remaining?: number;
	error?: string;
}

export type UsageCollection =
	| UsageSnapshot
	| ProfileUsageSnapshot
	| { snapshot: UsageSnapshot; observedAt?: Date | string; remaining?: number; available?: boolean };

export interface ProfileUsageCollector {
	collect(profile: ProviderProfile, now: Date): Promise<UsageCollection>;
}

export type UsageClock = { now(): Date } | (() => Date);

export interface ProfileUsageState {
	profileId: string;
	provider: UsageProvider;
	observedAt: Date;
	windows: RateWindow[];
	available: boolean;
	remaining?: number;
	error?: string;
}

export const EXPENSIVE_ROLES: readonly AgentRole[] = ["spec-planner", "worker", "verifier"];

function clockNow(clock: UsageClock): Date {
	return new Date(typeof clock === "function" ? clock().getTime() : clock.now().getTime());
}

function jsonFiles(paths: string[]): string[] {
	const files: string[] = [];
	const seen = new Set<string>();
	const visit = (path: string): void => {
		if (seen.has(path) || !existsSync(path)) return;
		seen.add(path);
		try {
			if (statSync(path).isDirectory()) {
				for (const entry of readdirSync(path)) if (entry === "auth.json") visit(join(path, entry));
			} else files.push(path);
		} catch {
			// A profile disappearing during a refresh is unavailable, not a controller failure.
		}
	};
	for (const path of paths) visit(path);
	return files;
}

/** Read only the selected profile's credential files. Values never enter durable state. */
export function loadProfileSubscriptionToken(profile: ProviderProfile): string | undefined {
	const paths = jsonFiles([...profile.authFiles, join(profile.agentDir, "auth.json")]);
	for (const path of paths) {
		try {
			const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			const anthropic = value.anthropic as Record<string, unknown> | undefined;
			const openai = value["openai-codex"] as Record<string, unknown> | undefined;
			const tokens = value.tokens as Record<string, unknown> | undefined;
			const oauth = value.claudeAiOauth as Record<string, unknown> | undefined;
			const token =
				profile.provider === "anthropic"
					? (anthropic?.access ?? oauth?.accessToken)
					: (openai?.access ?? tokens?.access_token);
			if (typeof token === "string" && token.length > 0) return token;
		} catch {
			// Malformed or inaccessible profile credentials make this profile unavailable.
		}
	}
	return undefined;
}

export class DefaultProfileUsageCollector implements ProfileUsageCollector {
	async collect(profile: ProviderProfile, now: Date): Promise<ProfileUsageSnapshot> {
		const token = loadProfileSubscriptionToken(profile);
		if (!token || (profile.provider === "anthropic" && !isOAuthToken(token))) {
			return {
				profileId: profile.id,
				provider: profile.provider,
				observedAt: now,
				windows: [],
				available: false,
				error: "subscription credentials unavailable",
			};
		}
		const snapshot = await fetchUsageSnapshot(profile.provider, token);
		return {
			profileId: profile.id,
			provider: profile.provider,
			observedAt: now,
			windows: snapshot?.windows ?? [],
			available: snapshot !== undefined,
			error: snapshot ? undefined : "usage request failed",
		};
	}
}

function normalizeCollection(profile: ProviderProfile, value: UsageCollection, now: Date): ProfileUsageState {
	const wrapped = value as {
		snapshot?: UsageSnapshot;
		observedAt?: Date | string;
		remaining?: number;
		available?: boolean;
	};
	const isWrapped = wrapped.snapshot !== undefined;
	const snapshot = (isWrapped ? wrapped.snapshot : value) as UsageSnapshot;
	const collectedProvider = snapshot.provider ?? (!isWrapped ? (value as ProfileUsageSnapshot).provider : undefined);
	if (collectedProvider && collectedProvider !== profile.provider)
		throw new Error("usage provider does not match profile");
	const observedAt: Date | string = isWrapped
		? (wrapped.observedAt ?? now)
		: "observedAt" in value && value.observedAt
			? value.observedAt
			: now;
	const windows = snapshot.windows ?? [];
	const direct = value as ProfileUsageSnapshot;
	const available = (isWrapped ? wrapped.available : direct.available) ?? (!snapshot.error && windows.length > 0);
	return {
		profileId: profile.id,
		provider: profile.provider,
		observedAt: new Date(observedAt),
		windows: [...windows],
		available,
		...((isWrapped ? wrapped.remaining : direct.remaining) !== undefined
			? { remaining: isWrapped ? wrapped.remaining : direct.remaining }
			: {}),
		...(snapshot.error || (!isWrapped ? direct.error : undefined)
			? { error: snapshot.error ?? (!isWrapped ? direct.error : undefined) }
			: {}),
	};
}

export interface ProfileUsageControllerOptions {
	collector?: ProfileUsageCollector | ((profile: ProviderProfile, now: Date) => Promise<UsageCollection>);
	clock?: UsageClock;
	reconcileAttempt?: (
		attempt: {
			attemptId: string;
			jobId: string;
			caseId: string;
			role: AgentRole;
			systemdUnit?: string;
			paneId?: string;
			worktree?: string;
		},
		reason: string,
		now: Date,
	) => Promise<void> | void;
}

/** Owns profile-scoped quota observations used by the controller scheduler. */
export class ProfileUsageController {
	private readonly states = new Map<string, ProfileUsageState>();
	private readonly collector: ProfileUsageCollector;
	private readonly clock: UsageClock;
	private readonly reconcileAttempt: ProfileUsageControllerOptions["reconcileAttempt"];

	constructor(
		private readonly database: BackgroundAgentsDatabase,
		private readonly profiles: readonly ProviderProfile[],
		options: ProfileUsageControllerOptions = {},
	) {
		this.clock = options.clock ?? (() => new Date());
		this.reconcileAttempt = options.reconcileAttempt;
		this.collector =
			typeof options.collector === "function"
				? { collect: options.collector }
				: (options.collector ?? new DefaultProfileUsageCollector());
		for (const profile of profiles)
			database.upsertProviderProfileState({
				profileId: profile.id,
				concurrencyLimit: profile.maxBackgroundAttempts,
				interactiveReserve: profile.interactiveReserve,
			});
	}

	get(profileId: string): ProfileUsageState | undefined {
		return this.states.get(profileId);
	}

	async refreshProfile(profileId: string, now = clockNow(this.clock)): Promise<ProfileUsageState> {
		const profile = this.profiles.find((item) => item.id === profileId);
		if (!profile) throw new Error(`Unknown provider profile: ${profileId}`);
		let state: ProfileUsageState;
		try {
			state = normalizeCollection(profile, await this.collector.collect(profile, now), now);
		} catch {
			state = {
				profileId,
				provider: profile.provider,
				observedAt: now,
				windows: [],
				available: false,
				error: "usage collector failed",
			};
		}
		this.states.set(profileId, state);
		this.database.setProviderProfileAvailability(profileId, state.available, state.observedAt);
		for (const window of state.windows) {
			this.database.recordUsageSnapshot({
				profileId,
				quotaWindow: window.label,
				used: Math.max(0, Math.round(window.usedPercent)),
				...(state.remaining === undefined ? {} : { remaining: state.remaining }),
				observedAt: state.observedAt,
				metadata: { usedPercent: window.usedPercent, resetsAt: window.resetsAt, available: state.available },
			});
		}
		const blocked =
			!state.available ||
			!this.isFresh(profile, now) ||
			(state.remaining !== undefined && state.remaining <= profile.interactiveReserve) ||
			state.windows.some((window) => window.usedPercent >= 100);
		if (blocked && this.reconcileAttempt) {
			const attempts = this.database.all<{
				id: string;
				job_id: string;
				case_id: string;
				role: AgentRole;
				systemd_unit: string | null;
				pane_id: string | null;
				worktree: string | null;
			}>(
				"SELECT id, job_id, case_id, role, systemd_unit, pane_id, worktree FROM attempts WHERE profile_id = ? AND state = 'running' AND role IN ('spec-planner', 'worker')",
				profileId,
			);
			const reason =
				state.error ?? (!state.available ? "provider usage unavailable" : "provider usage exhausted or stale");
			for (const attempt of attempts) {
				if (!this.database.pauseJobForUsage(attempt.id, reason, now)) continue;
				try {
					await this.reconcileAttempt(
						{
							attemptId: attempt.id,
							jobId: attempt.job_id,
							caseId: attempt.case_id,
							role: attempt.role,
							...(attempt.systemd_unit ? { systemdUnit: attempt.systemd_unit } : {}),
							...(attempt.pane_id ? { paneId: attempt.pane_id } : {}),
							...(attempt.worktree ? { worktree: attempt.worktree } : {}),
						},
						reason,
						now,
					);
				} catch {
					// A failed runtime stop must not prevent durable usage pausing.
				}
			}
		}
		return state;
	}

	async refresh(now = clockNow(this.clock)): Promise<ProfileUsageState[]> {
		const states: ProfileUsageState[] = [];
		for (const profile of this.profiles) states.push(await this.refreshProfile(profile.id, now));
		return states;
	}

	isFresh(profile: ProviderProfile, now = clockNow(this.clock)): boolean {
		const state = this.states.get(profile.id);
		const age = state ? now.getTime() - state.observedAt.getTime() : Number.NaN;
		return Number.isFinite(age) && age >= 0 && age < profile.usageStaleAfterMs;
	}

	/** Cheap classification and retrieval may proceed without quota data. */
	canSchedule(profile: ProviderProfile, role: AgentRole, now = clockNow(this.clock)): boolean {
		if (!EXPENSIVE_ROLES.includes(role)) return true;
		const state = this.states.get(profile.id);
		if (!state || !state.available || !this.isFresh(profile, now)) return false;
		if (state.remaining !== undefined && state.remaining <= profile.interactiveReserve) return false;
		return state.windows.every((window) => window.usedPercent < 100);
	}
}

export const UsageController = ProfileUsageController;
export const DefaultUsageCollector = DefaultProfileUsageCollector;
