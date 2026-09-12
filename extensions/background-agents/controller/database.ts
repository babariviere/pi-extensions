import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync as NativeDatabaseSync } from "node:sqlite";
import type {
	AgentRole,
	BackgroundSource,
	CaseState,
	Classification,
	MemoryEntry,
	RolloutMode,
	SourceEvent,
	SpecificationWorkItem,
	EvidenceManifest,
	VerificationRun,
	Confidence,
} from "../types.ts";
import { migrateDatabase } from "./migrations.ts";

const require = createRequire(import.meta.url);
const DEFAULT_LEASE_MS = 60_000;
const SOURCES: BackgroundSource[] = ["manual", "slack", "linear", "datadog"];
const ROLES: AgentRole[] = ["classifier", "investigator", "spec-planner", "worker", "verifier"];
const CASE_STATES: CaseState[] = [
	"intake",
	"classified",
	"investigating",
	"question-analysis",
	"specification",
	"awaiting-approval",
	"implementation",
	"verification",
	"pull-request-review",
	"paused",
	"paused-usage",
	"blocked",
	"retry",
	"handled",
	"cancelled",
];

const CASE_TRANSITIONS: Record<CaseState, readonly CaseState[]> = {
	intake: ["classified", "cancelled"],
	classified: ["investigating", "question-analysis", "specification", "blocked", "paused", "cancelled"],
	investigating: ["question-analysis", "specification", "awaiting-approval", "paused", "cancelled"],
	"question-analysis": ["investigating", "handled", "paused", "cancelled"],
	specification: ["awaiting-approval", "paused", "paused-usage", "cancelled"],
	"awaiting-approval": ["specification", "implementation", "paused", "cancelled"],
	implementation: ["verification", "retry", "blocked", "paused", "paused-usage", "cancelled"],
	verification: ["pull-request-review", "handled", "retry", "blocked", "paused", "paused-usage", "cancelled"],
	"pull-request-review": ["handled", "retry", "blocked", "paused", "paused-usage", "cancelled"],
	paused: [
		"classified",
		"investigating",
		"question-analysis",
		"specification",
		"awaiting-approval",
		"implementation",
		"verification",
		"pull-request-review",
		"retry",
		"blocked",
		"cancelled",
	],
	"paused-usage": ["specification", "implementation", "verification", "retry", "cancelled"],
	blocked: ["retry", "paused", "cancelled"],
	retry: ["investigating", "specification", "implementation", "verification", "paused", "cancelled"],
	handled: [],
	cancelled: [],
};

type Row = Record<string, unknown>;
type SqliteModule = { DatabaseSync: new (path: string, options?: Record<string, unknown>) => NativeDatabaseSync };

function requireNode24(): SqliteModule {
	const major = Number(process.versions.node.split(".")[0]);
	if (!Number.isFinite(major) || major < 24) {
		throw new Error(
			`The background-agents controller requires Node.js 24 or newer for node:sqlite (found ${process.versions.node})`,
		);
	}
	return require("node:sqlite") as SqliteModule;
}

function utcTimestamp(value: string | Date | undefined, field: string): string {
	const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid timestamp`);
	return date.toISOString();
}

export function jsonBoundary(value: unknown, field: string): string {
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(value);
	} catch (error) {
		throw new Error(`${field} must be JSON serializable`, { cause: error });
	}
	if (encoded === undefined) throw new Error(`${field} must be JSON serializable`);
	try {
		JSON.parse(encoded);
	} catch (error) {
		throw new Error(`${field} must contain valid JSON`, { cause: error });
	}
	return encoded;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
	return value.trim();
}

function source(value: string): BackgroundSource {
	if (!SOURCES.includes(value as BackgroundSource)) throw new Error(`source is invalid: ${value}`);
	return value as BackgroundSource;
}

function role(value: string): AgentRole {
	if (!ROLES.includes(value as AgentRole)) throw new Error(`role is invalid: ${value}`);
	return value as AgentRole;
}

function caseState(value: string): CaseState {
	if (!CASE_STATES.includes(value as CaseState)) throw new Error(`case state is invalid: ${value}`);
	return value as CaseState;
}

function rowString(row: Row, field: string): string {
	return String(row[field]);
}

export interface DatabaseOptions {
	timeoutMs?: number;
}

export interface DurableRolloutState {
	defaultMode: RolloutMode;
	sourceOverrides: Partial<Record<BackgroundSource, RolloutMode>>;
	repositoryOverrides: Record<string, RolloutMode>;
}

export interface DurableControlState {
	emergencyStop: boolean;
	stopEpoch: number;
	rollout: DurableRolloutState;
}

export interface NewCase {
	id?: string;
	title: string;
	source: BackgroundSource;
	repository?: string;
	priority?: number;
	rolloutMode?: RolloutMode;
	createdAt?: string | Date;
}

export interface SourceEventResult {
	eventId: string;
	caseId: string;
	inserted: boolean;
}

export interface SourceCursor {
	source: BackgroundSource;
	cursor?: string;
	revision?: string;
	updatedAt: string;
}

export interface JobInput {
	id?: string;
	caseId: string;
	workItemId?: string;
	role: AgentRole;
	priority?: number;
	manifestId?: string;
	expectedBaseSha?: string;
	expectedCandidateSha?: string;
}

export interface JobClaim {
	jobId: string;
	attemptId: string;
	leaseId: string;
	generation: number;
	expiresAt: string;
	profileId?: string;
	model?: string;
	stopEpoch: number;
}

export type UsageStopStatus = "pending" | "systemd-confirmed" | "pane-confirmed" | "complete";

export interface UsageStopIntent {
	id: string;
	attemptId: string;
	jobId: string;
	caseId: string;
	profileId?: string;
	systemdUnit?: string;
	tabId?: string;
	paneId?: string;
	status: UsageStopStatus;
	systemdConfirmed: boolean;
	tabConfirmed: boolean;
	paneConfirmed: boolean;
	reason: string;
	createdAt: string;
	updatedAt: string;
}

export interface ProviderProfileStateInput {
	profileId: string;
	available?: boolean;
	activeAttempts?: number;
	concurrencyLimit?: number;
	interactiveReserve?: number;
	cooldownUntil?: string;
	updatedAt?: string | Date;
}

export interface UsageSnapshotInput {
	profileId: string;
	quotaWindow: string;
	used: number;
	remaining?: number;
	observedAt: string | Date;
	metadata?: unknown;
}

export interface EffectInput {
	id?: string;
	operationKey: string;
	provider: string;
	action: string;
	intent: unknown;
}

export interface EffectClaim {
	effectId: string;
	operationKey: string;
	expiresAt: string;
}

export interface StoredEffect {
	id: string;
	operationKey: string;
	provider: string;
	action: string;
	intent: unknown;
	remoteIdentifier?: string;
	outcome?: unknown;
	reconciliationState: "pending" | "running" | "succeeded" | "failed" | "unknown";
	claimOwner?: string;
	leaseExpiresAt?: string;
	attemptCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface TrustedCheckpointInput {
	attemptId: string;
	kind: string;
	path?: string;
	digest?: string;
	metadata?: unknown;
	createdAt?: string | Date;
}

export interface RecoveryDecisionInput {
	attemptId: string;
	decision: string;
	reason: string;
	systemdState?: string;
	worktreeState?: string;
	checkpointId?: string;
	replacementAttemptId?: string;
	metadata?: unknown;
	createdAt?: string | Date;
}

export interface TrustedCheckpoint {
	id: string;
	attemptId: string;
	kind: string;
	path?: string;
	digest?: string;
	metadata: unknown;
	createdAt: string;
}

export interface QueuedRecovery {
	jobId: string;
	attemptId: string;
	generation: number;
}

export interface PolicyInput {
	id?: string;
	scope: string;
	version: string;
	policy: unknown;
	proposedBy: string;
}

export interface FeedbackInput {
	id?: string;
	caseId?: string;
	classificationId?: string;
	correction: unknown;
	actor: string;
}

export interface MemoryEntryInput {
	id?: string;
	caseId?: string;
	finding: string;
	outcome?: string;
	rootCause?: string;
	evidenceSummary: string;
	confidence: number;
	scope: string;
	approvalStatus?: "pending" | "approved" | "rejected";
	supersedesId?: string;
}

export interface SpecificationVersionInput {
	caseId: string;
	specification: unknown;
	decisions?: unknown[];
	unresolvedQuestions?: unknown[];
	permissions?: unknown;
	plannerSummary?: string;
	decomposition: SpecificationWorkItem[];
	materialHash: string;
}

export interface StoredSpecificationVersion {
	id: string;
	caseId: string;
	version: number;
	specification: unknown;
	decisions: unknown[];
	unresolvedQuestions: unknown[];
	permissions: unknown;
	decomposition: SpecificationWorkItem[];
	orderedWorkItems: string[];
	plannerSummary?: string;
	materialHash: string;
	createdAt: string;
}

export interface SpecificationApprovalInput {
	caseId: string;
	specVersion: number;
	materialHash: string;
	permissions: string[];
	orderedWorkItems: string[];
	decision?: "approved" | "rejected" | "changes-requested";
	actor: string;
}

export interface StoredSpecificationApproval {
	id: string;
	caseId: string;
	specVersion: number;
	materialHash: string;
	decision: "approved" | "rejected" | "changes-requested";
	actor: string;
	permissions: string[];
	orderedWorkItems: string[];
	createdAt: string;
}

export interface WorkItemApprovalInput {
	caseId: string;
	workItemId: string;
	specVersion: number;
	actor: string;
}

export interface StoredWorkItemApproval {
	id: string;
	caseId: string;
	workItemId: string;
	specVersion: number;
	decision: "approved" | "rejected";
	actor: string;
	createdAt: string;
}

export interface InvestigationReportInput {
	caseId: string;
	attemptId?: string;
	evidence: unknown;
	relatedCases: unknown[];
	report: unknown;
}

export interface QuickFixProposalInput {
	caseId: string;
	findings: string;
	scope: string;
	risks: string[];
	verificationPlan: string[];
	rolloutMode: RolloutMode;
	decision: "pending" | "approved" | "observed" | "needs-human" | "rejected";
	decisionReason: string;
	decidedBy?: string;
}

export interface StoredQuickFixProposal {
	id: string;
	caseId: string;
	workItemId: string;
	findings: string;
	scope: string;
	risks: string[];
	verificationPlan: string[];
	rolloutMode: RolloutMode;
	decision: QuickFixProposalInput["decision"];
	decisionReason: string;
	decidedBy?: string;
	createdAt: string;
	updatedAt: string;
}

export interface QuestionBriefInput {
	caseId: string;
	attemptId?: string;
	question: string;
	findings: unknown;
	sources: unknown[];
	confidence: number;
	uncertainties?: string[];
	limits: unknown;
}

export interface EvidenceManifestInput {
	id?: string;
	caseId: string;
	manifest: EvidenceManifest;
}

export interface VerificationRunInput {
	id?: string;
	manifestId: string;
	report: {
		verdict: VerificationRun["verdict"];
		confidence: Confidence;
		ciChecks: Record<string, string>;
		rationale: string;
		uncertainties: string[];
		replay?: { commands: Array<{ actual: unknown }> };
		ciHistory?: unknown[][];
	};
	replayOf?: string;
	resultVersion?: number;
}

export interface StoredPolicy {
	id: string;
	scope: string;
	version: string;
	policy: unknown;
	status: "proposed" | "active" | "retired";
	proposedBy: string;
	activatedBy?: string;
	createdAt: string;
	activatedAt?: string;
}

export class IllegalCaseTransitionError extends Error {
	constructor(caseId: string, from: CaseState, to: CaseState) {
		super(`Illegal case transition for ${caseId}: ${from} -> ${to}`);
		this.name = "IllegalCaseTransitionError";
	}
}

export class BackgroundAgentsDatabase {
	readonly path: string;
	private readonly database: NativeDatabaseSync;

	constructor(path: string, options: DatabaseOptions = {}) {
		this.path = path;
		const { DatabaseSync } = requireNode24();
		if (path !== ":memory:" && !path.startsWith("file:")) mkdirSync(dirname(path), { recursive: true });
		this.database = new DatabaseSync(path, {
			enableForeignKeyConstraints: true,
			timeout: options.timeoutMs ?? 5_000,
		});
		try {
			this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
			migrateDatabase(this.database, path);
		} catch (error) {
			this.database.close();
			throw error;
		}
	}

	get isOpen(): boolean {
		return this.database.isOpen;
	}

	close(): void {
		if (this.database.isOpen) this.database.close();
	}

	exec(sql: string): void {
		this.database.exec(sql);
	}

	run(sql: string, ...parameters: unknown[]): { changes: number } {
		return this.database.prepare(sql).run(...(parameters as never[])) as { changes: number };
	}

	get<T extends Row = Row>(sql: string, ...parameters: unknown[]): T | undefined {
		return this.database.prepare(sql).get(...(parameters as never[])) as T | undefined;
	}

	all<T extends Row = Row>(sql: string, ...parameters: unknown[]): T[] {
		return this.database.prepare(sql).all(...(parameters as never[])) as T[];
	}

	getControlState(): DurableControlState {
		const row = this.database
			.prepare(
				"SELECT emergency_stop, stop_epoch, rollout_default, source_overrides, repository_overrides FROM controller_control_state WHERE id = 1",
			)
			.get() as Row | undefined;
		if (!row) throw new Error("controller control state is unavailable");
		const parse = (field: string): Record<string, RolloutMode> => {
			try {
				const value: unknown = JSON.parse(rowString(row, field));
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
				return value as Record<string, RolloutMode>;
			} catch (error) {
				throw new Error("Stored control state has invalid " + field, { cause: error });
			}
		};
		return {
			emergencyStop: Number(row.emergency_stop) === 1,
			stopEpoch: Number(row.stop_epoch),
			rollout: {
				defaultMode: rowString(row, "rollout_default") as RolloutMode,
				sourceOverrides: parse("source_overrides"),
				repositoryOverrides: parse("repository_overrides"),
			},
		};
	}

	/** Apply configuration defaults only to a never-initialized database. */
	initializeControlState(rollout: DurableRolloutState): void {
		this.withTransaction(() => {
			const state = this.database.prepare("SELECT initialized FROM controller_control_state WHERE id = 1").get() as
				| Row
				| undefined;
			if (Number(state?.initialized ?? 0) !== 0) return;
			this.database
				.prepare(
					"UPDATE controller_control_state SET initialized = 1, rollout_default = ?, source_overrides = ?, repository_overrides = ?, updated_at = ? WHERE id = 1",
				)
				.run(
					rollout.defaultMode,
					jsonBoundary(rollout.sourceOverrides, "source overrides"),
					jsonBoundary(rollout.repositoryOverrides, "repository overrides"),
					new Date().toISOString(),
				);
		});
	}

	isEmergencyStop(): boolean {
		return this.getControlState().emergencyStop;
	}

	getEmergencyStopEpoch(): number {
		return this.getControlState().stopEpoch;
	}

	setEmergencyStop(enabled: boolean, actor: string, now = new Date()): void {
		const createdAt = utcTimestamp(now, "now");
		this.withTransaction(() => {
			const current = this.database
				.prepare("SELECT emergency_stop, stop_epoch FROM controller_control_state WHERE id = 1")
				.get() as Row | undefined;
			if (!current) throw new Error("controller control state is unavailable");
			const wasEnabled = Number(current.emergency_stop) === 1;
			const epoch = Number(current.stop_epoch) + (enabled && !wasEnabled ? 1 : 0);
			this.database
				.prepare(
					"UPDATE controller_control_state SET initialized = 1, emergency_stop = ?, stop_epoch = ?, updated_at = ? WHERE id = 1",
				)
				.run(enabled ? 1 : 0, epoch, createdAt);
			if (enabled && !wasEnabled) {
				this.database
					.prepare(
						"INSERT OR IGNORE INTO emergency_stop_attempts (stop_epoch, attempt_id, tab_id, tab_confirmed, created_at, updated_at) SELECT ?, id, tab_id, CASE WHEN tab_id IS NULL THEN 1 ELSE 0 END, ?, ? FROM attempts WHERE state = 'running'",
					)
					.run(epoch, createdAt, createdAt);
			}
			if (!enabled) {
				const pending = this.database
					.prepare(
						"SELECT count(*) AS count FROM emergency_stop_attempts WHERE stop_epoch = ? AND (systemd_confirmed = 0 OR tab_confirmed = 0 OR reconciled = 0)",
					)
					.get(epoch) as Row;
				if (Number(pending.count) > 0) throw new Error("emergency stop attempts are not fully reconciled");
			}
			this.recordOperatorEventInTransaction(
				enabled ? "emergency-stop.enabled" : "emergency-stop.disabled",
				actor,
				{ enabled },
				createdAt,
			);
		});
	}

	listEmergencyStopAttempts(): Array<{
		stopEpoch: number;
		attemptId: string;
		tabId?: string;
		systemdConfirmed: boolean;
		tabConfirmed: boolean;
		reconciled: boolean;
	}> {
		const epoch = this.getEmergencyStopEpoch();
		return this.database
			.prepare(
				"SELECT stop_epoch, attempt_id, tab_id, systemd_confirmed, tab_confirmed, reconciled FROM emergency_stop_attempts WHERE stop_epoch = ? ORDER BY attempt_id",
			)
			.all(epoch)
			.map((row) => {
				const value = row as Row;
				return {
					stopEpoch: Number(value.stop_epoch),
					attemptId: rowString(value, "attempt_id"),
					...(value.tab_id == null ? {} : { tabId: rowString(value, "tab_id") }),
					systemdConfirmed: Number(value.systemd_confirmed) === 1,
					tabConfirmed: Number(value.tab_confirmed) === 1,
					reconciled: Number(value.reconciled) === 1,
				};
			});
	}

	markEmergencyStopAttempt(
		attemptId: string,
		status: { systemdConfirmed?: boolean; tabConfirmed?: boolean; reconciled?: boolean },
	): void {
		const epoch = this.getEmergencyStopEpoch();
		this.run(
			"UPDATE emergency_stop_attempts SET systemd_confirmed = coalesce(?, systemd_confirmed), tab_confirmed = coalesce(?, tab_confirmed), reconciled = coalesce(?, reconciled), updated_at = ? WHERE stop_epoch = ? AND attempt_id = ?",
			status.systemdConfirmed === undefined ? null : status.systemdConfirmed ? 1 : 0,
			status.tabConfirmed === undefined ? null : status.tabConfirmed ? 1 : 0,
			status.reconciled === undefined ? null : status.reconciled ? 1 : 0,
			new Date().toISOString(),
			epoch,
			requiredString(attemptId, "attemptId"),
		);
	}

	/** An attempt may publish only if it was not invalidated by a stop epoch. */
	attemptMayPublish(attemptId: string, stopEpoch: number): boolean {
		const row = this.get<{
			attempt_epoch: number;
			current_epoch: number;
			emergency_stop: number;
			publish_invalidated: number;
			state: string;
		}>(
			"SELECT a.stop_epoch AS attempt_epoch, c.stop_epoch AS current_epoch, c.emergency_stop, a.publish_invalidated, a.state FROM attempts a CROSS JOIN controller_control_state c WHERE a.id = ?",
			attemptId,
		);
		return Boolean(
			row &&
				row.state === "running" &&
				Number(row.attempt_epoch) === stopEpoch &&
				Number(row.current_epoch) === stopEpoch &&
				Number(row.publish_invalidated) === 0 &&
				Number(row.emergency_stop) === 0,
		);
	}

	/** Workers for a materialized specification obey the durable rollout and approval gates. */
	workerDispatchAllowed(jobId: string): boolean {
		const job = this.get<{
			case_id: string;
			work_item_id: string | null;
			rollout_mode: RolloutMode;
			item_spec_version_id: string | null;
			item_state: string | null;
			ordinal: number | null;
		}>(
			"SELECT j.case_id, j.work_item_id, c.rollout_mode, wi.spec_version_id AS item_spec_version_id, wi.state AS item_state, wi.ordinal FROM jobs j JOIN cases c ON c.id = j.case_id LEFT JOIN work_items wi ON wi.id = j.work_item_id WHERE j.id = ? AND j.role = 'worker'",
			jobId,
		);
		if (!job || !job.work_item_id || !job.item_spec_version_id) return true;
		if (job.item_state === "cancelled" || job.item_state === "verified") return false;
		const current = this.get<{ id: string; version: number }>(
			"SELECT id, version FROM spec_versions WHERE case_id = ? ORDER BY version DESC LIMIT 1",
			job.case_id,
		);
		if (!current || current.id !== job.item_spec_version_id) return false;
		if (!this.get("SELECT id FROM approvals WHERE spec_version_id = ? AND decision = 'approved'", current.id))
			return false;
		if (job.rollout_mode === "autonomous-pr") return true;
		if (job.rollout_mode !== "supervised") return false;
		return Boolean(
			this.get(
				"SELECT id FROM work_item_approvals WHERE case_id = ? AND work_item_id = ? AND spec_version = ? AND decision = 'approved'",
				job.case_id,
				job.work_item_id,
				current.version,
			),
		);
	}

	assertAttemptMayPublish(attemptId: string, stopEpoch: number): void {
		if (!this.attemptMayPublish(attemptId, stopEpoch)) throw new Error("attempt was invalidated before publication");
	}

	withAttemptPublication<T>(attemptId: string, stopEpoch: number, callback: () => T): T {
		return this.withTransaction(() => {
			this.assertAttemptMayPublish(attemptId, stopEpoch);
			const result = callback();
			this.assertAttemptMayPublish(attemptId, stopEpoch);
			return result;
		});
	}

	/** Pause only jobs captured by an emergency-stop activation. */
	pauseEmergencyStopJobs(jobIds: readonly string[], now = new Date()): number {
		const pausedAt = utcTimestamp(now, "now");
		return this.withTransaction(() => {
			let changed = 0;
			for (const jobId of jobIds) {
				const job = this.database
					.prepare("SELECT state FROM jobs WHERE id = ?")
					.get(requiredString(jobId, "jobId")) as Row | undefined;
				if (!job || !["queued", "running"].includes(rowString(job, "state"))) continue;
				this.database
					.prepare("INSERT INTO emergency_stop_paused_jobs (job_id, paused_at) VALUES (?, ?)")
					.run(jobId, pausedAt);
				this.database
					.prepare("UPDATE attempts SET state = 'paused', finished_at = ? WHERE job_id = ? AND state = 'running'")
					.run(pausedAt, jobId);
				this.database
					.prepare("DELETE FROM attempt_leases WHERE attempt_id IN (SELECT id FROM attempts WHERE job_id = ?)")
					.run(jobId);
				this.database
					.prepare(
						"UPDATE jobs SET state = 'paused', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?",
					)
					.run(pausedAt, jobId);
				changed += 1;
			}
			this.database.exec(
				"UPDATE provider_profile_state SET active_attempts = (SELECT count(*) FROM attempts WHERE profile_id = provider_profile_state.profile_id AND state = 'running')",
			);
			return changed;
		});
	}

	/** Resume only jobs paused by an emergency stop. A later claim creates the next attempt generation. */
	resumeEmergencyStopJobs(now = new Date()): number {
		const resumedAt = utcTimestamp(now, "now");
		return this.withTransaction(() => {
			const jobs = this.database
				.prepare(
					"SELECT job_id FROM emergency_stop_paused_jobs WHERE resumed_at IS NULL ORDER BY paused_at, job_id",
				)
				.all() as Row[];
			let resumed = 0;
			for (const row of jobs) {
				const result = this.database
					.prepare(
						"UPDATE jobs SET state = 'queued', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND state = 'paused'",
					)
					.run(resumedAt, rowString(row, "job_id"));
				if (result.changes === 1) resumed += 1;
			}
			this.database
				.prepare("UPDATE emergency_stop_paused_jobs SET resumed_at = ? WHERE resumed_at IS NULL")
				.run(resumedAt);
			return resumed;
		});
	}

	setRollout(
		scope: "global" | "source" | "repository",
		value: RolloutMode,
		actor: string,
		target?: string,
		now = new Date(),
	): void {
		if (!["observe", "supervised", "autonomous-pr"].includes(value)) throw new Error("rollout value is invalid");
		const createdAt = utcTimestamp(now, "now");
		this.withTransaction(() => {
			const current = this.getControlState().rollout;
			if (scope === "global") current.defaultMode = value;
			else if (scope === "source") {
				if (!target || !SOURCES.includes(target as BackgroundSource)) throw new Error("rollout source is required");
				current.sourceOverrides[target as BackgroundSource] = value;
			} else {
				if (!target?.trim()) throw new Error("repository is required");
				current.repositoryOverrides[target] = value;
			}
			this.database
				.prepare(
					"UPDATE controller_control_state SET initialized = 1, rollout_default = ?, source_overrides = ?, repository_overrides = ?, updated_at = ? WHERE id = 1",
				)
				.run(
					current.defaultMode,
					jsonBoundary(current.sourceOverrides, "source overrides"),
					jsonBoundary(current.repositoryOverrides, "repository overrides"),
					createdAt,
				);
			this.recordOperatorEventInTransaction(
				"rollout.set",
				actor,
				{ scope, value, ...(target ? { target } : {}) },
				createdAt,
			);
		});
	}

	recordOperatorEvent(eventType: string, actor: string, details: unknown = {}, now = new Date()): string {
		const createdAt = utcTimestamp(now, "now");
		return this.withTransaction(() => this.recordOperatorEventInTransaction(eventType, actor, details, createdAt));
	}

	private recordOperatorEventInTransaction(
		eventType: string,
		actor: string,
		details: unknown,
		createdAt: string,
	): string {
		const id = randomUUID();
		this.database
			.prepare("INSERT INTO operator_events (id, event_type, actor, details, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(
				id,
				requiredString(eventType, "eventType"),
				requiredString(actor, "actor"),
				jsonBoundary(details, "operator event details"),
				createdAt,
			);
		return id;
	}

	withTransaction<T>(callback: () => T): T {
		if (this.database.isTransaction) return callback();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = callback();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {
				// Preserve the operation error if rollback itself fails.
			}
			throw error;
		}
	}

	createCase(input: NewCase): string {
		const id = input.id ?? randomUUID();
		const createdAt = utcTimestamp(input.createdAt, "createdAt");
		const title = requiredString(input.title, "title");
		const caseSource = source(input.source);
		const rolloutMode = input.rolloutMode ?? "observe";
		if (!["observe", "supervised", "autonomous-pr"].includes(rolloutMode)) throw new Error("rolloutMode is invalid");
		this.withTransaction(() => {
			this.database
				.prepare(
					"INSERT INTO cases (id, state, title, repository, source, priority, rollout_mode, created_at, updated_at) VALUES (?, 'intake', ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					title,
					input.repository ?? null,
					caseSource,
					input.priority ?? 0,
					rolloutMode,
					createdAt,
					createdAt,
				);
			this.appendEvent(id, null, "intake", "system", "case created", {});
		});
		return id;
	}

	recordSourceEvent(
		event: SourceEvent,
		options: { caseId?: string; rolloutMode?: RolloutMode; priority?: number } = {},
	): SourceEventResult {
		return this.withTransaction(() => this.recordSourceEventInTransaction(event, options));
	}

	recordSourceEventAndAdvanceCursor(
		event: SourceEvent,
		cursor: { cursor?: string; revision?: string },
		options: { caseId?: string; rolloutMode?: RolloutMode; priority?: number } = {},
	): SourceEventResult {
		return this.withTransaction(() => {
			const result = this.recordSourceEventInTransaction(event, options);
			this.setSourceCursorInTransaction(event.source, cursor.cursor, cursor.revision);
			return result;
		});
	}

	/** Ensure an intake case has one durable classifier job. Safe to call for every delivery. */
	reconcileClassifierJob(caseId: string): string | undefined {
		const id = requiredString(caseId, "caseId");
		return this.withTransaction(() => {
			const current = this.database.prepare("SELECT state FROM cases WHERE id = ?").get(id) as Row | undefined;
			if (!current || rowString(current, "state") !== "intake") return undefined;
			const classified = this.database.prepare("SELECT id FROM classifications WHERE case_id = ? LIMIT 1").get(id);
			if (classified) return undefined;
			const existing = this.database
				.prepare(
					"SELECT id, state FROM jobs WHERE case_id = ? AND role = 'classifier' AND state <> 'cancelled' ORDER BY created_at DESC LIMIT 1",
				)
				.get(id) as Row | undefined;
			if (existing) {
				return ["queued", "running"].includes(rowString(existing, "state")) ? rowString(existing, "id") : undefined;
			}
			const jobId = randomUUID();
			this.database
				.prepare("INSERT INTO jobs (id, case_id, role, priority) VALUES (?, ?, 'classifier', 0)")
				.run(jobId, id);
			return jobId;
		});
	}

	reconcileClassifierRetries(
		maxAttempts: number,
		retryBackoffMs: number,
		now = new Date(),
	): { requeued: number; blocked: number } {
		if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
			throw new Error("maxAttempts must be a positive integer");
		if (!Number.isSafeInteger(retryBackoffMs) || retryBackoffMs < 0)
			throw new Error("retryBackoffMs must be a non-negative integer");
		const timestamp = utcTimestamp(now, "now");
		return this.withTransaction(() => {
			const failed = this.database
				.prepare(
					"SELECT j.id, j.case_id, a.generation, a.failure, a.finished_at FROM jobs j JOIN cases c ON c.id = j.case_id JOIN attempts a ON a.job_id = j.id AND a.generation = (SELECT max(previous.generation) FROM attempts previous WHERE previous.job_id = j.id) WHERE j.role = 'classifier' AND j.state = 'failed' AND c.state = 'intake' AND a.state = 'failed'",
				)
				.all() as Row[];
			let requeued = 0;
			let blocked = 0;
			for (const row of failed) {
				const generation = Number(row.generation);
				if (generation >= maxAttempts) {
					const failure = row.failure == null ? "unknown classifier failure" : rowString(row, "failure");
					const reason = `classifier retry budget exhausted after ${generation} attempt${generation === 1 ? "" : "s"}: ${failure}`;
					this.database
						.prepare(
							"UPDATE jobs SET state = 'needs-human', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND state = 'failed'",
						)
						.run(timestamp, rowString(row, "id"));
					this.database
						.prepare("UPDATE cases SET state = 'blocked', updated_at = ? WHERE id = ? AND state = 'intake'")
						.run(timestamp, rowString(row, "case_id"));
					this.appendEvent(rowString(row, "case_id"), "intake", "blocked", "classifier", reason, {
						attempts: generation,
						maxAttempts,
						failure,
					});
					blocked += 1;
					continue;
				}
				if (row.finished_at == null) continue;
				const finishedAt = Date.parse(rowString(row, "finished_at"));
				if (!Number.isFinite(finishedAt) || finishedAt + retryBackoffMs > Date.parse(timestamp)) continue;
				const jobId = rowString(row, "id");
				const nextGeneration = generation + 1;
				const nextAttemptId = randomUUID();
				this.database
					.prepare(
						"UPDATE jobs SET state = 'queued', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND state = 'failed'",
					)
					.run(timestamp, jobId);
				this.database
					.prepare(
						"INSERT INTO attempts (id, job_id, case_id, role, generation, state) VALUES (?, ?, ?, 'classifier', ?, 'queued')",
					)
					.run(nextAttemptId, jobId, rowString(row, "case_id"), nextGeneration);
				requeued += 1;
			}
			return { requeued, blocked };
		});
	}

	/** Reconcile after restart without reviving a failed classifier job. */
	reconcileClassifierJobs(): string[] {
		return this.database
			.prepare("SELECT id FROM cases WHERE state = 'intake' ORDER BY created_at, id")
			.all()
			.flatMap((row) => {
				const id = this.reconcileClassifierJob(rowString(row as Row, "id"));
				return id ? [id] : [];
			});
	}

	getSourceCursor(sourceName: BackgroundSource): SourceCursor | undefined {
		const row = this.database
			.prepare("SELECT source, cursor, revision, updated_at FROM source_cursors WHERE source = ?")
			.get(source(sourceName)) as Row | undefined;
		if (!row) return undefined;
		return {
			source: source(rowString(row, "source")),
			cursor: row.cursor == null ? undefined : rowString(row, "cursor"),
			revision: row.revision == null ? undefined : rowString(row, "revision"),
			updatedAt: rowString(row, "updated_at"),
		};
	}

	getSourceEvent(eventId: string): SourceEvent | undefined {
		const row = this.database
			.prepare(
				"SELECT source, source_key, revision, received_at, title, body, fingerprint, repository, service, metadata FROM source_events WHERE id = ?",
			)
			.get(requiredString(eventId, "eventId")) as Row | undefined;
		if (!row) return undefined;
		let metadata: Record<string, unknown> = {};
		if (row.metadata != null) {
			try {
				const value = JSON.parse(rowString(row, "metadata"));
				if (value && typeof value === "object" && !Array.isArray(value))
					metadata = value as Record<string, unknown>;
			} catch (error) {
				throw new Error("Stored source event contains invalid metadata", { cause: error });
			}
		}
		return {
			source: source(rowString(row, "source")),
			sourceKey: rowString(row, "source_key"),
			revision: rowString(row, "revision"),
			receivedAt: rowString(row, "received_at"),
			title: rowString(row, "title"),
			body: rowString(row, "body"),
			...(row.fingerprint == null ? {} : { fingerprint: rowString(row, "fingerprint") }),
			...(row.repository == null ? {} : { repository: rowString(row, "repository") }),
			...(row.service == null ? {} : { service: rowString(row, "service") }),
			metadata,
		};
	}

	setSourceCursor(sourceName: BackgroundSource, cursor?: string, revision?: string): void {
		this.withTransaction(() => this.setSourceCursorInTransaction(sourceName, cursor, revision));
	}

	private setSourceCursorInTransaction(sourceName: BackgroundSource, cursor?: string, revision?: string): void {
		this.database
			.prepare(
				"INSERT INTO source_cursors (source, cursor, revision, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, revision = excluded.revision, updated_at = excluded.updated_at",
			)
			.run(source(sourceName), cursor ?? null, revision ?? null, new Date().toISOString());
	}

	private recordSourceEventInTransaction(
		event: SourceEvent,
		options: { caseId?: string; rolloutMode?: RolloutMode; priority?: number },
	): SourceEventResult {
		const caseSource = source(event.source);
		const sourceKey = requiredString(event.sourceKey, "sourceKey");
		const revision = event.revision ?? "";
		const receivedAt = utcTimestamp(event.receivedAt, "receivedAt");
		const title = requiredString(event.title, "title");
		const body = typeof event.body === "string" ? event.body : requiredString(event.body, "body");
		const metadata = jsonBoundary(event.metadata ?? {}, "metadata");
		{
			const existing = this.database
				.prepare("SELECT id, case_id FROM source_events WHERE source = ? AND source_key = ? AND revision = ?")
				.get(caseSource, sourceKey, revision) as Row | undefined;
			if (existing) {
				if (event.repository)
					this.database
						.prepare("UPDATE cases SET repository = ?, updated_at = ? WHERE id = ? AND repository IS NULL")
						.run(event.repository, new Date().toISOString(), rowString(existing, "case_id"));
				return { eventId: rowString(existing, "id"), caseId: rowString(existing, "case_id"), inserted: false };
			}

			const prior = options.caseId
				? undefined
				: (this.database
						.prepare(
							"SELECT case_id FROM source_events WHERE source = ? AND source_key = ? ORDER BY created_at DESC LIMIT 1",
						)
						.get(caseSource, sourceKey) as Row | undefined);
			const caseId = options.caseId ?? (prior ? rowString(prior, "case_id") : randomUUID());
			if (options.caseId) {
				const found = this.database.prepare("SELECT id FROM cases WHERE id = ?").get(caseId);
				if (!found) throw new Error(`Unknown case: ${caseId}`);
			} else if (!prior) {
				const createdAt = new Date().toISOString();
				this.database
					.prepare(
						"INSERT INTO cases (id, state, title, repository, source, priority, rollout_mode, created_at, updated_at) VALUES (?, 'intake', ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						caseId,
						title,
						event.repository ?? null,
						caseSource,
						options.priority ?? 0,
						options.rolloutMode ?? "observe",
						createdAt,
						createdAt,
					);
				this.appendEvent(caseId, null, "intake", "source", "source event received", {});
			}
			const eventId = randomUUID();
			this.database
				.prepare(
					"INSERT INTO source_events (id, case_id, source, source_key, revision, received_at, title, body, fingerprint, repository, service, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					eventId,
					caseId,
					caseSource,
					sourceKey,
					revision,
					receivedAt,
					title,
					body,
					event.fingerprint ?? null,
					event.repository ?? null,
					event.service ?? null,
					metadata,
				);
			if (event.repository)
				this.database
					.prepare("UPDATE cases SET repository = ?, updated_at = ? WHERE id = ? AND repository IS NULL")
					.run(event.repository, new Date().toISOString(), caseId);
			return { eventId, caseId, inserted: true };
		}
	}

	transitionCase(caseId: string, to: CaseState, actor: string, reason?: string, metadata: unknown = {}): void {
		const target = caseState(to);
		this.withTransaction(() => {
			const current = this.database.prepare("SELECT state FROM cases WHERE id = ?").get(caseId) as Row | undefined;
			if (!current) throw new Error(`Unknown case: ${caseId}`);
			const from = caseState(rowString(current, "state"));
			if (!CASE_TRANSITIONS[from].includes(target)) throw new IllegalCaseTransitionError(caseId, from, target);
			const changed = this.database
				.prepare("UPDATE cases SET state = ?, updated_at = ? WHERE id = ? AND state = ?")
				.run(target, new Date().toISOString(), caseId, from);
			if (changed.changes !== 1) throw new Error(`Case changed concurrently: ${caseId}`);
			this.appendEvent(caseId, from, target, requiredString(actor, "actor"), reason, metadata);
		});
	}

	private appendEvent(
		caseId: string,
		from: CaseState | null,
		to: CaseState,
		actor: string,
		reason: string | undefined,
		metadata: unknown,
	): void {
		this.database
			.prepare(
				"INSERT INTO case_events (id, case_id, from_state, to_state, actor, reason, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(randomUUID(), caseId, from, to, actor, reason ?? null, jsonBoundary(metadata, "event metadata"));
	}

	createArtifact(input: {
		id?: string;
		caseId?: string;
		attemptId?: string;
		kind: string;
		path?: string;
		url?: string;
		hash?: string;
		transcriptReference?: string;
		metadata?: unknown;
	}): string {
		const id = input.id ?? randomUUID();
		this.withTransaction(() => {
			this.database
				.prepare(
					"INSERT INTO artifacts (id, case_id, attempt_id, kind, path, url, hash, transcript_reference, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					input.caseId ?? null,
					input.attemptId ?? null,
					requiredString(input.kind, "kind"),
					input.path ?? null,
					input.url ?? null,
					input.hash ?? null,
					input.transcriptReference ?? null,
					jsonBoundary(input.metadata ?? {}, "artifact metadata"),
				);
		});
		return id;
	}

	createEvidenceManifest(input: EvidenceManifestInput): string {
		const id = input.id ?? randomUUID();
		const manifest = input.manifest;
		this.withTransaction(() => {
			const versionRow = this.database
				.prepare("SELECT coalesce(max(version), 0) AS version FROM evidence_manifests WHERE case_id = ?")
				.get(input.caseId) as Row;
			const version = Number(versionRow.version) + 1;
			this.database
				.prepare(
					"INSERT INTO evidence_manifests (id, case_id, version, base_sha, candidate_sha, commands, environment_requirements, outputs, checksums, manifest_json, tool_versions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					input.caseId,
					version,
					manifest.baseSha,
					manifest.candidateSha,
					jsonBoundary(manifest.commands, "evidence commands"),
					jsonBoundary(
						manifest.commands.flatMap((command) => command.environment),
						"evidence environment",
					),
					jsonBoundary(
						manifest.commands.map((command) => command.actual ?? null),
						"evidence outputs",
					),
					jsonBoundary(
						manifest.commands.map((command) => command.artifactChecksums ?? {}),
						"evidence checksums",
					),
					jsonBoundary(manifest, "evidence manifest"),
					jsonBoundary(manifest.toolVersions ?? {}, "evidence tool versions"),
				);
		});
		return id;
	}

	getEvidenceManifest(id: string): EvidenceManifest | undefined {
		const row = this.database
			.prepare(
				"SELECT manifest_json, base_sha, candidate_sha, commands, created_at FROM evidence_manifests WHERE id = ?",
			)
			.get(id) as Row | undefined;
		if (!row) return undefined;
		if (typeof row.manifest_json === "string") return JSON.parse(row.manifest_json) as EvidenceManifest;
		return {
			version: 1,
			baseSha: rowString(row, "base_sha"),
			candidateSha: rowString(row, "candidate_sha"),
			commands: JSON.parse(rowString(row, "commands")),
			createdAt: rowString(row, "created_at"),
		};
	}

	getEvidenceManifestOwner(id: string): { caseId: string; baseSha: string; candidateSha: string } | undefined {
		const row = this.database
			.prepare("SELECT case_id, base_sha, candidate_sha FROM evidence_manifests WHERE id = ?")
			.get(id) as Row | undefined;
		if (!row) return undefined;
		return {
			caseId: rowString(row, "case_id"),
			baseSha: rowString(row, "base_sha"),
			candidateSha: rowString(row, "candidate_sha"),
		};
	}

	createVerificationRun(input: VerificationRunInput): string {
		const id = input.id ?? randomUUID();
		this.withTransaction(() => {
			this.database
				.prepare(
					"INSERT INTO verification_runs (id, manifest_id, verdict, confidence, ci_checks, rationale, uncertainties, actual_results, replay_history, ci_history, replay_of, result_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					input.manifestId,
					input.report.verdict,
					input.report.confidence.score,
					jsonBoundary(input.report.ciChecks, "CI checks"),
					input.report.rationale,
					jsonBoundary(input.report.uncertainties, "verification uncertainties"),
					jsonBoundary(input.report.replay?.commands.map((command) => command.actual) ?? [], "actual results"),
					jsonBoundary(input.replayOf ? [input.replayOf] : [], "replay history"),
					jsonBoundary(input.report.ciHistory ?? [], "CI history"),
					input.replayOf ?? null,
					input.resultVersion ?? 1,
				);
		});
		return id;
	}

	getReadyVerification(
		manifestId: string,
		verificationRunId: string,
	): { id: string; baseSha: string; candidateSha: string; ciChecks: Record<string, string> } | undefined {
		const row = this.database
			.prepare(
				"SELECT vr.id, vr.verdict, vr.ci_checks, em.base_sha, em.candidate_sha FROM verification_runs vr JOIN evidence_manifests em ON em.id = vr.manifest_id WHERE vr.id = ? AND vr.manifest_id = ? ORDER BY vr.created_at DESC, vr.rowid DESC LIMIT 1",
			)
			.get(verificationRunId, manifestId) as Row | undefined;
		if (!row || rowString(row, "verdict") !== "pass") return undefined;
		const latest = this.database
			.prepare("SELECT id FROM verification_runs WHERE manifest_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
			.get(manifestId) as Row | undefined;
		if (!latest || rowString(latest, "id") !== rowString(row, "id")) return undefined;
		return {
			id: rowString(row, "id"),
			baseSha: rowString(row, "base_sha"),
			candidateSha: rowString(row, "candidate_sha"),
			ciChecks: JSON.parse(rowString(row, "ci_checks")) as Record<string, string>,
		};
	}

	listVerificationRuns(manifestId: string): VerificationRun[] {
		return this.database
			.prepare(
				"SELECT id, manifest_id, verdict, confidence, ci_checks, rationale, uncertainties, created_at, replay_history, ci_history, result_version FROM verification_runs WHERE manifest_id = ? ORDER BY created_at, rowid",
			)
			.all(manifestId)
			.map((row) => ({
				id: rowString(row as Row, "id"),
				manifestId: rowString(row as Row, "manifest_id"),
				version: Number((row as Row).result_version ?? 1),
				verdict: rowString(row as Row, "verdict") as VerificationRun["verdict"],
				confidence: {
					score: Number((row as Row).confidence),
					rationale: rowString(row as Row, "rationale"),
					uncertainties: JSON.parse(rowString(row as Row, "uncertainties")),
				},
				ciChecks: JSON.parse(rowString(row as Row, "ci_checks")),
				rationale: rowString(row as Row, "rationale"),
				uncertainties: JSON.parse(rowString(row as Row, "uncertainties")),
				replayHistory: JSON.parse(rowString(row as Row, "replay_history")),
				ciHistory: JSON.parse(rowString(row as Row, "ci_history")),
				createdAt: rowString(row as Row, "created_at"),
			}));
	}

	createJob(input: JobInput): string {
		const id = input.id ?? randomUUID();
		this.withTransaction(() => {
			this.database
				.prepare(
					"INSERT INTO jobs (id, case_id, work_item_id, role, priority, manifest_id, expected_base_sha, expected_candidate_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					requiredString(input.caseId, "caseId"),
					input.workItemId ?? null,
					role(input.role),
					input.priority ?? 0,
					input.manifestId ?? null,
					input.expectedBaseSha ?? null,
					input.expectedCandidateSha ?? null,
				);
		});
		return id;
	}

	claimJob(
		jobId: string,
		owner: string,
		leaseMs = DEFAULT_LEASE_MS,
		now = new Date(),
		assignment?: { profileId?: string; model?: string },
	): JobClaim | null {
		const claimedAt = utcTimestamp(now, "now");
		if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be a positive integer");
		return this.withTransaction(() => {
			if (this.isEmergencyStop()) return null;
			const stopEpoch = this.getEmergencyStopEpoch();
			const job = this.database.prepare("SELECT id, case_id, role, state FROM jobs WHERE id = ?").get(jobId) as
				| Row
				| undefined;
			if (!job) throw new Error(`Unknown job: ${jobId}`);
			if (rowString(job, "state") === "running") {
				const current = this.database
					.prepare(
						"SELECT a.id, l.expires_at FROM attempts a LEFT JOIN attempt_leases l ON l.attempt_id = a.id WHERE a.job_id = ? ORDER BY a.generation DESC LIMIT 1",
					)
					.get(jobId) as Row | undefined;
				if (current?.expires_at && rowString(current, "expires_at") > claimedAt) return null;
				if (current) {
					this.database
						.prepare(
							"UPDATE attempts SET state = 'failed', failure = ?, finished_at = ? WHERE id = ? AND state = 'running'",
						)
						.run("lease expired", claimedAt, rowString(current, "id"));
					this.database.prepare("DELETE FROM attempt_leases WHERE attempt_id = ?").run(rowString(current, "id"));
				}
			} else if (rowString(job, "state") !== "queued") {
				return null;
			}
			const queuedAttempt = this.database
				.prepare(
					"SELECT id, generation FROM attempts WHERE job_id = ? AND state = 'queued' ORDER BY generation DESC LIMIT 1",
				)
				.get(jobId) as Row | undefined;
			if (assignment?.profileId) {
				const profile = this.database
					.prepare("SELECT concurrency_limit FROM provider_profile_state WHERE profile_id = ?")
					.get(assignment.profileId) as Row | undefined;
				if (!profile) throw new Error(`Unknown provider profile: ${assignment.profileId}`);
				const active = this.database
					.prepare("SELECT count(*) AS count FROM attempts WHERE profile_id = ? AND state = 'running'")
					.get(assignment.profileId) as Row;
				if (Number(active.count) >= Number(profile.concurrency_limit)) return null;
			}
			const previous = this.database
				.prepare("SELECT coalesce(max(generation), 0) AS generation FROM attempts WHERE job_id = ?")
				.get(jobId) as Row;
			const generation = queuedAttempt ? Number(queuedAttempt.generation) : Number(previous.generation) + 1;
			const attemptId = queuedAttempt ? rowString(queuedAttempt, "id") : randomUUID();
			const leaseId = randomUUID();
			const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
			if (queuedAttempt) {
				this.database
					.prepare(
						"UPDATE attempts SET state = 'running', profile_id = ?, model = ?, stop_epoch = ?, heartbeat_at = ?, started_at = ? WHERE id = ? AND state = 'queued'",
					)
					.run(
						assignment?.profileId ?? null,
						assignment?.model ?? null,
						stopEpoch,
						claimedAt,
						claimedAt,
						attemptId,
					);
			} else {
				this.database
					.prepare(
						"INSERT INTO attempts (id, job_id, case_id, role, generation, state, profile_id, model, stop_epoch, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)",
					)
					.run(
						attemptId,
						jobId,
						rowString(job, "case_id"),
						rowString(job, "role"),
						generation,
						assignment?.profileId ?? null,
						assignment?.model ?? null,
						stopEpoch,
						claimedAt,
						claimedAt,
					);
			}
			this.database
				.prepare(
					"INSERT INTO attempt_leases (id, attempt_id, owner, generation, expires_at, last_renewed_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(leaseId, attemptId, requiredString(owner, "owner"), generation, expiresAt, claimedAt);
			this.database
				.prepare("UPDATE jobs SET state = 'running', claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?")
				.run(owner, claimedAt, claimedAt, jobId);
			if (assignment?.profileId) this.refreshProviderProfileActivity(assignment.profileId, now);
			return {
				jobId,
				attemptId,
				leaseId,
				generation,
				expiresAt,
				stopEpoch,
				...(assignment?.profileId ? { profileId: assignment.profileId } : {}),
				...(assignment?.model ? { model: assignment.model } : {}),
			};
		});
	}

	upsertProviderProfileState(input: ProviderProfileStateInput): void {
		const updatedAt = utcTimestamp(input.updatedAt, "updatedAt");
		this.withTransaction(() => {
			this.database
				.prepare(
					"INSERT INTO provider_profile_state (profile_id, available, active_attempts, concurrency_limit, interactive_reserve, cooldown_until, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET available = provider_profile_state.available, active_attempts = provider_profile_state.active_attempts, concurrency_limit = excluded.concurrency_limit, interactive_reserve = excluded.interactive_reserve, cooldown_until = excluded.cooldown_until, updated_at = excluded.updated_at",
				)
				.run(
					requiredString(input.profileId, "profileId"),
					input.available === undefined ? 1 : input.available ? 1 : 0,
					input.activeAttempts ?? 0,
					input.concurrencyLimit ?? 1,
					input.interactiveReserve ?? 0,
					input.cooldownUntil ?? null,
					updatedAt,
				);
		});
	}

	setProviderProfileAvailability(profileId: string, available: boolean, updatedAt = new Date()): void {
		this.run(
			"UPDATE provider_profile_state SET available = ?, updated_at = ? WHERE profile_id = ?",
			available ? 1 : 0,
			utcTimestamp(updatedAt, "updatedAt"),
			requiredString(profileId, "profileId"),
		);
	}

	refreshProviderProfileActivity(profileId: string, updatedAt = new Date()): void {
		this.run(
			"UPDATE provider_profile_state SET active_attempts = (SELECT count(*) FROM attempts WHERE profile_id = ? AND state = 'running'), updated_at = ? WHERE profile_id = ?",
			profileId,
			utcTimestamp(updatedAt, "updatedAt"),
			profileId,
		);
	}

	/** Persist a usage pause while retaining the attempt's worktree and generation. */
	pauseJobForUsage(attemptId: string, reason: string, now = new Date()): boolean {
		const pausedAt = utcTimestamp(now, "now");
		return this.withTransaction(() => {
			const attempt = this.get<{
				job_id: string;
				case_id: string;
				profile_id: string | null;
				role: AgentRole;
				systemd_unit: string | null;
				tab_id: string | null;
				pane_id: string | null;
				state: string;
			}>(
				"SELECT job_id, case_id, profile_id, role, systemd_unit, tab_id, pane_id, state FROM attempts WHERE id = ?",
				attemptId,
			);
			if (!attempt || attempt.state !== "running" || attempt.role === "verifier") return false;
			this.run(
				"UPDATE attempts SET state = 'paused', publish_invalidated = 1, failure = ?, finished_at = ? WHERE id = ? AND state = 'running'",
				requiredString(reason, "reason"),
				pausedAt,
				attemptId,
			);
			this.run("DELETE FROM attempt_leases WHERE attempt_id = ?", attemptId);
			this.run(
				"INSERT INTO usage_paused_jobs (job_id, attempt_id, profile_id, reason, paused_at) VALUES (?, ?, ?, ?, ?)",
				attempt.job_id,
				attemptId,
				attempt.profile_id,
				requiredString(reason, "reason"),
				pausedAt,
			);
			const systemdConfirmed = attempt.systemd_unit == null ? 1 : 0;
			const tabConfirmed = attempt.tab_id == null ? 1 : 0;
			const paneConfirmed = attempt.tab_id == null && attempt.pane_id == null ? 1 : 0;
			this.run(
				"INSERT INTO usage_stop_intents (id, attempt_id, job_id, case_id, profile_id, systemd_unit, tab_id, pane_id, status, systemd_confirmed, tab_confirmed, pane_confirmed, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				randomUUID(),
				attemptId,
				attempt.job_id,
				attempt.case_id,
				attempt.profile_id,
				attempt.systemd_unit,
				attempt.tab_id,
				attempt.pane_id,
				systemdConfirmed && tabConfirmed && paneConfirmed ? "complete" : "pending",
				systemdConfirmed,
				tabConfirmed,
				paneConfirmed,
				requiredString(reason, "reason"),
				pausedAt,
				pausedAt,
			);
			this.run(
				"UPDATE jobs SET state = 'paused', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND state = 'running'",
				pausedAt,
				attempt.job_id,
			);
			const caseRow = this.get<{ state: CaseState }>("SELECT state FROM cases WHERE id = ?", attempt.case_id);
			if (caseRow && caseRow.state !== "paused-usage" && CASE_TRANSITIONS[caseRow.state].includes("paused-usage")) {
				this.run(
					"UPDATE cases SET state = 'paused-usage', updated_at = ? WHERE id = ? AND state = ?",
					pausedAt,
					attempt.case_id,
					caseRow.state,
				);
				this.appendEvent(attempt.case_id, caseRow.state, "paused-usage", "usage-controller", reason, { attemptId });
			}
			if (attempt.profile_id) this.refreshProviderProfileActivity(attempt.profile_id, now);
			return true;
		});
	}

	listPendingUsageStopIntents(): UsageStopIntent[] {
		return this.all<Row>(
			"SELECT id, attempt_id, job_id, case_id, profile_id, systemd_unit, tab_id, pane_id, status, systemd_confirmed, tab_confirmed, pane_confirmed, reason, created_at, updated_at FROM usage_stop_intents WHERE status <> 'complete' ORDER BY created_at, id",
		).map((row) => ({
			id: rowString(row, "id"),
			attemptId: rowString(row, "attempt_id"),
			jobId: rowString(row, "job_id"),
			caseId: rowString(row, "case_id"),
			...(row.profile_id == null ? {} : { profileId: rowString(row, "profile_id") }),
			...(row.systemd_unit == null ? {} : { systemdUnit: rowString(row, "systemd_unit") }),
			...(row.tab_id == null ? {} : { tabId: rowString(row, "tab_id") }),
			...(row.pane_id == null ? {} : { paneId: rowString(row, "pane_id") }),
			status: rowString(row, "status") as UsageStopStatus,
			systemdConfirmed: Number(row.systemd_confirmed) === 1,
			tabConfirmed: Number(row.tab_confirmed) === 1,
			paneConfirmed: Number(row.pane_confirmed) === 1,
			reason: rowString(row, "reason"),
			createdAt: rowString(row, "created_at"),
			updatedAt: rowString(row, "updated_at"),
		}));
	}

	markUsageStopIntent(
		attemptId: string,
		status: { systemdConfirmed?: boolean; tabConfirmed?: boolean; paneConfirmed?: boolean },
		now = new Date(),
	): void {
		this.withTransaction(() => {
			const current = this.get<{
				systemd_confirmed: number;
				tab_confirmed: number;
				pane_confirmed: number;
				tab_id: string | null;
			}>(
				"SELECT systemd_confirmed, tab_confirmed, pane_confirmed, tab_id FROM usage_stop_intents WHERE attempt_id = ? AND status <> 'complete'",
				attemptId,
			);
			if (!current) return;
			const systemdConfirmed = status.systemdConfirmed ?? Number(current.systemd_confirmed) === 1;
			const tabConfirmed = status.tabConfirmed ?? Number(current.tab_confirmed) === 1;
			const paneConfirmed = status.paneConfirmed ?? Number(current.pane_confirmed) === 1;
			const runtimeConfirmed = current.tab_id == null ? paneConfirmed : tabConfirmed;
			this.run(
				"UPDATE usage_stop_intents SET status = ?, systemd_confirmed = ?, tab_confirmed = ?, pane_confirmed = ?, updated_at = ? WHERE attempt_id = ? AND status <> 'complete'",
				systemdConfirmed && runtimeConfirmed
					? "complete"
					: systemdConfirmed
						? "systemd-confirmed"
						: runtimeConfirmed
							? "pane-confirmed"
							: "pending",
				systemdConfirmed ? 1 : 0,
				tabConfirmed ? 1 : 0,
				paneConfirmed ? 1 : 0,
				utcTimestamp(now, "now"),
				attemptId,
			);
		});
	}

	hasPendingUsageStop(caseId: string): boolean {
		return Boolean(
			this.get("SELECT id FROM usage_stop_intents WHERE case_id = ? AND status <> 'complete' LIMIT 1", caseId),
		);
	}

	usagePausedJobs(caseId: string): Array<{ jobId: string; attemptId: string; role: AgentRole }> {
		return this.all<{ job_id: string; attempt_id: string; role: AgentRole }>(
			"SELECT u.job_id, u.attempt_id, j.role FROM usage_paused_jobs u JOIN jobs j ON j.id = u.job_id WHERE j.case_id = ? AND u.resumed_at IS NULL ORDER BY u.paused_at, u.job_id",
			caseId,
		).map((row) => ({ jobId: row.job_id, attemptId: row.attempt_id, role: row.role }));
	}

	resumeUsageJobs(caseId: string, now = new Date()): number {
		const resumedAt = utcTimestamp(now, "now");
		return this.withTransaction(() => {
			if (this.hasPendingUsageStop(caseId))
				throw new Error(`Case ${caseId} cannot resume while a usage stop is pending`);
			const jobs = this.usagePausedJobs(caseId);
			let resumed = 0;
			for (const job of jobs) {
				const changed = this.run(
					"UPDATE jobs SET state = 'queued', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND state = 'paused'",
					resumedAt,
					job.jobId,
				);
				if (changed.changes === 1) {
					this.run(
						"UPDATE usage_paused_jobs SET resumed_at = ? WHERE job_id = ? AND resumed_at IS NULL",
						resumedAt,
						job.jobId,
					);
					const previous = this.get<{ generation: number }>(
						"SELECT coalesce(max(generation), 0) AS generation FROM attempts WHERE job_id = ?",
						job.jobId,
					);
					const jobDetails = this.get<{ case_id: string; role: AgentRole }>(
						"SELECT case_id, role FROM jobs WHERE id = ?",
						job.jobId,
					);
					if (!jobDetails) throw new Error(`Unknown usage-paused job: ${job.jobId}`);
					this.run(
						"INSERT INTO attempts (id, job_id, case_id, role, generation, state) VALUES (?, ?, ?, ?, ?, 'queued')",
						randomUUID(),
						job.jobId,
						jobDetails.case_id,
						jobDetails.role,
						Number(previous?.generation ?? 0) + 1,
					);
					resumed += 1;
				}
			}
			return resumed;
		});
	}

	createWorkItemApproval(input: WorkItemApprovalInput): { approvalId: string; jobId: string } {
		const caseId = requiredString(input.caseId, "caseId");
		const workItemId = requiredString(input.workItemId, "workItemId");
		const actor = requiredString(input.actor, "actor");
		if (/^(agent|system|model|classifier)(:|$)/i.test(actor))
			throw new Error("Work-item approval requires an explicit human actor");
		if (!Number.isSafeInteger(input.specVersion) || input.specVersion <= 0)
			throw new Error("specVersion must be a positive integer");
		const approvalId = randomUUID();
		const jobId = randomUUID();
		this.withTransaction(() => {
			const current = this.get<{ id: string; version: number }>(
				"SELECT id, version FROM spec_versions WHERE case_id = ? ORDER BY version DESC LIMIT 1",
				caseId,
			);
			if (!current || current.version !== input.specVersion)
				throw new Error(`Work-item approval is stale for ${caseId}`);
			const item = this.get<{
				case_id: string;
				id: string;
				spec_version_id: string | null;
				ordinal: number;
				state: string;
				parent_id: string | null;
			}>("SELECT case_id, id, spec_version_id, ordinal, state, parent_id FROM work_items WHERE id = ?", workItemId);
			if (!item || item.case_id !== caseId || item.spec_version_id !== current.id)
				throw new Error(`Unknown work item for specification: ${workItemId}`);
			if (item.state === "cancelled") throw new Error(`Work item is cancelled: ${workItemId}`);
			if (item.state !== "queued") throw new Error(`Work item is already running or complete: ${workItemId}`);
			const ordered = this.get<{ ordered_work_items: string }>(
				"SELECT ordered_work_items FROM spec_versions WHERE id = ?",
				current.id,
			);
			let ids: unknown;
			try {
				ids = JSON.parse(ordered?.ordered_work_items ?? "[]");
			} catch {
				throw new Error("stored specification order is invalid");
			}
			if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
				throw new Error("stored specification order is invalid");
			const orderedIds = ids as string[];
			const index = orderedIds.indexOf(workItemId);
			if (index < 0) throw new Error(`Work-item approval is out of order: ${workItemId}`);
			for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
				const previous = this.get<{ state: string }>(
					"SELECT state FROM work_items WHERE id = ?",
					orderedIds[previousIndex],
				);
				if (!previous || previous.state !== "verified")
					throw new Error(`Parent work item is not verified before ${workItemId}`);
			}
			if (item.parent_id) {
				const parent = this.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", item.parent_id);
				if (parent?.state !== "verified") throw new Error(`Parent work item is not verified before ${workItemId}`);
			}
			const caseState = this.get<{ state: string; rollout_mode: RolloutMode }>(
				"SELECT state, rollout_mode FROM cases WHERE id = ?",
				caseId,
			);
			if (!caseState || caseState.rollout_mode !== "supervised")
				throw new Error("work-item approval is available only in supervised mode");
			if (["cancelled", "handled"].includes(caseState.state))
				throw new Error(`Case ${caseId} is cancelled or complete`);
			if (!this.get("SELECT id FROM approvals WHERE spec_version_id = ? AND decision = 'approved'", current.id))
				throw new Error(`Specification ${input.specVersion} is not approved`);
			if (
				this.database
					.prepare("SELECT id FROM jobs WHERE work_item_id = ? AND role = 'worker' AND state <> 'cancelled'")
					.get(workItemId)
			)
				throw new Error(`Work item is already running or approved: ${workItemId}`);
			this.run(
				"INSERT INTO work_item_approvals (id, case_id, work_item_id, spec_version, decision, actor) VALUES (?, ?, ?, ?, 'approved', ?)",
				approvalId,
				caseId,
				workItemId,
				input.specVersion,
				actor,
			);
			this.run(
				"INSERT INTO jobs (id, case_id, work_item_id, role) VALUES (?, ?, ?, 'worker')",
				jobId,
				caseId,
				workItemId,
			);
			this.recordOperatorEventInTransaction(
				"work-item.approved",
				actor,
				{ caseId, workItemId, specVersion: input.specVersion },
				new Date().toISOString(),
			);
		});
		return { approvalId, jobId };
	}

	recordUsageSnapshot(input: UsageSnapshotInput): void {
		const observedAt = utcTimestamp(input.observedAt, "observedAt");
		if (!Number.isSafeInteger(input.used) || input.used < 0) throw new Error("used must be a non-negative integer");
		if (input.remaining !== undefined && (!Number.isSafeInteger(input.remaining) || input.remaining < 0))
			throw new Error("remaining must be a non-negative integer");
		this.withTransaction(() => {
			if (
				!this.database
					.prepare("SELECT profile_id FROM provider_profile_state WHERE profile_id = ?")
					.get(input.profileId)
			)
				throw new Error(`Unknown provider profile: ${input.profileId}`);
			this.database
				.prepare(
					"INSERT INTO usage_snapshots (id, profile_id, quota_window, used, remaining, observed_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					randomUUID(),
					requiredString(input.profileId, "profileId"),
					requiredString(input.quotaWindow, "quotaWindow"),
					input.used,
					input.remaining ?? null,
					observedAt,
					jsonBoundary(input.metadata ?? {}, "usage metadata"),
				);
		});
	}

	latestUsageSnapshots(profileId: string): Array<{
		quotaWindow: string;
		used: number;
		remaining?: number;
		observedAt: string;
		metadata: unknown;
	}> {
		const rows = this.all<Row>(
			"SELECT current.quota_window, current.used, current.remaining, current.observed_at, current.metadata FROM usage_snapshots AS current WHERE current.profile_id = ? AND current.observed_at = (SELECT max(previous.observed_at) FROM usage_snapshots AS previous WHERE previous.profile_id = current.profile_id AND previous.quota_window = current.quota_window) ORDER BY current.quota_window",
			profileId,
		);
		return rows.map((row) => {
			let metadata: unknown;
			try {
				metadata = JSON.parse(rowString(row, "metadata"));
			} catch (error) {
				throw new Error("Stored usage metadata contains invalid JSON", { cause: error });
			}
			return {
				quotaWindow: rowString(row, "quota_window"),
				used: Number(row.used),
				...(row.remaining == null ? {} : { remaining: Number(row.remaining) }),
				observedAt: rowString(row, "observed_at"),
				metadata,
			};
		});
	}

	renewLease(attemptId: string, owner: string, leaseMs = DEFAULT_LEASE_MS, now = new Date()): boolean {
		if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be a positive integer");
		const renewedAt = utcTimestamp(now, "now");
		const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
		return this.withTransaction(() => {
			const result = this.database
				.prepare(
					"UPDATE attempt_leases SET expires_at = ?, last_renewed_at = ? WHERE attempt_id = ? AND owner = ? AND expires_at > ?",
				)
				.run(expiresAt, renewedAt, attemptId, requiredString(owner, "owner"), renewedAt);
			if (result.changes === 1) {
				this.database.prepare("UPDATE attempts SET heartbeat_at = ? WHERE id = ?").run(renewedAt, attemptId);
				return true;
			}
			return false;
		});
	}

	createEffect(input: EffectInput): string {
		const id = input.id ?? randomUUID();
		this.withTransaction(() => {
			this.database
				.prepare(
					"INSERT INTO external_effects (id, operation_key, provider, action, intent) VALUES (?, ?, ?, ?, ?)",
				)
				.run(
					id,
					requiredString(input.operationKey, "operationKey"),
					requiredString(input.provider, "provider"),
					requiredString(input.action, "action"),
					jsonBoundary(input.intent, "intent"),
				);
		});
		return id;
	}

	/** Insert an effect intent once, returning the existing record for duplicate requests. */
	ensureEffect(input: EffectInput): string {
		const id = input.id ?? randomUUID();
		const operationKey = requiredString(input.operationKey, "operationKey");
		const provider = requiredString(input.provider, "provider");
		const action = requiredString(input.action, "action");
		const intent = jsonBoundary(input.intent, "intent");
		return this.withTransaction(() => {
			const existing = this.database
				.prepare("SELECT id, provider, action, intent FROM external_effects WHERE operation_key = ?")
				.get(operationKey) as Row | undefined;
			if (existing) {
				if (
					rowString(existing, "provider") !== provider ||
					rowString(existing, "action") !== action ||
					rowString(existing, "intent") !== intent
				)
					throw new Error("Effect operation key is already used for a different intent: " + operationKey);
				return rowString(existing, "id");
			}
			this.database
				.prepare(
					"INSERT INTO external_effects (id, operation_key, provider, action, intent) VALUES (?, ?, ?, ?, ?)",
				)
				.run(id, operationKey, provider, action, intent);
			return id;
		});
	}

	getEffect(operationKey: string): StoredEffect | undefined {
		const row = this.database
			.prepare(
				"SELECT id, operation_key, provider, action, intent, remote_identifier, outcome, reconciliation_state, claim_owner, lease_expires_at, attempt_count, created_at, updated_at FROM external_effects WHERE operation_key = ?",
			)
			.get(requiredString(operationKey, "operationKey")) as Row | undefined;
		if (!row) return undefined;
		let intent: unknown;
		let outcome: unknown;
		try {
			intent = JSON.parse(rowString(row, "intent"));
			outcome = row.outcome == null ? undefined : JSON.parse(rowString(row, "outcome"));
		} catch (error) {
			throw new Error("Stored external effect contains invalid JSON", { cause: error });
		}
		return {
			id: rowString(row, "id"),
			operationKey: rowString(row, "operation_key"),
			provider: rowString(row, "provider"),
			action: rowString(row, "action"),
			intent,
			...(row.remote_identifier == null ? {} : { remoteIdentifier: rowString(row, "remote_identifier") }),
			...(outcome === undefined ? {} : { outcome }),
			reconciliationState: rowString(row, "reconciliation_state") as StoredEffect["reconciliationState"],
			...(row.claim_owner == null ? {} : { claimOwner: rowString(row, "claim_owner") }),
			...(row.lease_expires_at == null ? {} : { leaseExpiresAt: rowString(row, "lease_expires_at") }),
			attemptCount: Number(row.attempt_count),
			createdAt: rowString(row, "created_at"),
			updatedAt: rowString(row, "updated_at"),
		};
	}

	completeEffect(operationKey: string, owner: string, outcome: unknown = {}, remoteIdentifier?: string): void {
		this.setEffectOutcome(operationKey, owner, "succeeded", outcome, remoteIdentifier);
	}

	markEffectUnknown(operationKey: string, owner: string, outcome: unknown): void {
		this.setEffectOutcome(operationKey, owner, "unknown", outcome);
	}

	failEffect(operationKey: string, owner: string, outcome: unknown): void {
		this.setEffectOutcome(operationKey, owner, "failed", outcome);
	}

	private setEffectOutcome(
		operationKey: string,
		owner: string,
		state: "succeeded" | "failed" | "unknown",
		outcome: unknown,
		remoteIdentifier?: string,
	): void {
		const changed = this.withTransaction(() =>
			this.database
				.prepare(
					"UPDATE external_effects SET reconciliation_state = ?, outcome = ?, remote_identifier = coalesce(?, remote_identifier), claim_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE operation_key = ? AND reconciliation_state = 'running' AND claim_owner = ?",
				)
				.run(
					state,
					jsonBoundary(outcome, "effect outcome"),
					remoteIdentifier ?? null,
					new Date().toISOString(),
					requiredString(operationKey, "operationKey"),
					requiredString(owner, "owner"),
				),
		);
		if (changed.changes !== 1) throw new Error("Effect claim is no longer owned: " + operationKey);
	}

	claimEffect(operationKey: string, owner: string, leaseMs = DEFAULT_LEASE_MS, now = new Date()): EffectClaim | null {
		const claimedAt = utcTimestamp(now, "now");
		if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be a positive integer");
		return this.withTransaction(() => {
			const effect = this.database
				.prepare("SELECT id, reconciliation_state, lease_expires_at FROM external_effects WHERE operation_key = ?")
				.get(operationKey) as Row | undefined;
			if (!effect) throw new Error(`Unknown effect: ${operationKey}`);
			const state = rowString(effect, "reconciliation_state");
			if (state === "succeeded") return null;
			if (state === "running" && effect.lease_expires_at && rowString(effect, "lease_expires_at") > claimedAt)
				return null;
			const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
			this.database
				.prepare(
					"UPDATE external_effects SET reconciliation_state = 'running', claim_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?",
				)
				.run(requiredString(owner, "owner"), expiresAt, claimedAt, rowString(effect, "id"));
			return { effectId: rowString(effect, "id"), operationKey, expiresAt };
		});
	}

	createPolicy(input: PolicyInput): string {
		const id = input.id ?? randomUUID();
		this.withTransaction(() => {
			this.database
				.prepare("INSERT INTO classifier_policies (id, scope, version, policy, proposed_by) VALUES (?, ?, ?, ?, ?)")
				.run(
					id,
					requiredString(input.scope, "scope"),
					requiredString(input.version, "version"),
					jsonBoundary(input.policy, "policy"),
					requiredString(input.proposedBy, "proposedBy"),
				);
		});
		return id;
	}

	getPolicy(scope: string, version: string): StoredPolicy | undefined {
		return this.readPolicy(
			this.database
				.prepare(
					"SELECT id, scope, version, policy, status, proposed_by, activated_by, created_at, activated_at FROM classifier_policies WHERE scope = ? AND version = ?",
				)
				.get(requiredString(scope, "scope"), requiredString(version, "version")) as Row | undefined,
		);
	}

	getActivePolicy(scope: string): StoredPolicy | undefined {
		return this.readPolicy(
			this.database
				.prepare(
					"SELECT id, scope, version, policy, status, proposed_by, activated_by, created_at, activated_at FROM classifier_policies WHERE scope = ? AND status = 'active'",
				)
				.get(requiredString(scope, "scope")) as Row | undefined,
		);
	}

	private readPolicy(row: Row | undefined): StoredPolicy | undefined {
		if (!row) return undefined;
		let policy: unknown;
		try {
			policy = JSON.parse(rowString(row, "policy"));
		} catch (error) {
			throw new Error("Stored classifier policy contains invalid JSON", { cause: error });
		}
		return {
			id: rowString(row, "id"),
			scope: rowString(row, "scope"),
			version: rowString(row, "version"),
			policy,
			status: rowString(row, "status") as StoredPolicy["status"],
			proposedBy: rowString(row, "proposed_by"),
			activatedBy: row.activated_by == null ? undefined : rowString(row, "activated_by"),
			createdAt: rowString(row, "created_at"),
			activatedAt: row.activated_at == null ? undefined : rowString(row, "activated_at"),
		};
	}

	activatePolicy(policyId: string, actor: string, now = new Date()): void {
		const activatedAt = utcTimestamp(now, "now");
		const humanActor = requiredString(actor, "actor");
		if (/^(agent|system|model|classifier)(:|$)/i.test(humanActor))
			throw new Error("Only an explicit human action may activate a classifier policy");
		this.withTransaction(() => {
			const policy = this.database
				.prepare("SELECT scope, status FROM classifier_policies WHERE id = ?")
				.get(policyId) as Row | undefined;
			if (!policy) throw new Error(`Unknown classifier policy: ${policyId}`);
			this.database
				.prepare(
					"UPDATE classifier_policies SET status = 'retired', activated_at = NULL WHERE scope = ? AND status = 'active'",
				)
				.run(rowString(policy, "scope"));
			this.database
				.prepare(
					"UPDATE classifier_policies SET status = 'active', activated_by = ?, activated_at = ? WHERE id = ?",
				)
				.run(humanActor, activatedAt, policyId);
		});
	}

	insertClassification(caseId: string, classification: Classification): string {
		const id = randomUUID();
		this.withTransaction(() => {
			this.database
				.prepare(
					"INSERT INTO classifications (id, case_id, input_kind, disposition, actionability, noise, confidence, rationale, fingerprint, model_version, policy_version, influential_examples) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					caseId,
					classification.inputKind,
					classification.disposition,
					classification.actionability,
					classification.noise,
					classification.confidence,
					classification.rationale,
					classification.fingerprint ?? null,
					classification.modelVersion,
					classification.policyVersion,
					jsonBoundary(classification.influentialExamples, "influentialExamples"),
				);
		});
		return id;
	}

	recordFeedback(input: FeedbackInput): string {
		const id = input.id ?? randomUUID();
		const actor = requiredString(input.actor, "actor");
		if (/^(agent|system|model|classifier)(:|$)/i.test(actor))
			throw new Error("Only explicit human action may create classifier feedback");
		this.withTransaction(() => {
			this.database
				.prepare("INSERT INTO feedback (id, case_id, classification_id, correction, actor) VALUES (?, ?, ?, ?, ?)")
				.run(
					id,
					input.caseId ?? null,
					input.classificationId ?? null,
					jsonBoundary(input.correction, "correction"),
					actor,
				);
		});
		return id;
	}

	createMemoryEntry(input: MemoryEntryInput): string {
		const id = input.id ?? randomUUID();
		if (input.approvalStatus === "approved")
			throw new Error("Memory entries require an explicit human approval action");
		if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 100)
			throw new Error("confidence must be between 0 and 100");
		this.withTransaction(() => {
			this.database
				.prepare(
					"INSERT INTO memory_entries (id, case_id, finding, outcome, root_cause, evidence_summary, confidence, scope, approval_status, supersedes_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					input.caseId ?? null,
					requiredString(input.finding, "finding"),
					input.outcome ?? null,
					input.rootCause ?? null,
					requiredString(input.evidenceSummary, "evidenceSummary"),
					input.confidence,
					requiredString(input.scope, "scope"),
					input.approvalStatus ?? "pending",
					input.supersedesId ?? null,
				);
		});
		return id;
	}

	approveMemoryEntry(memoryId: string, actor: string, status: "approved" | "rejected" = "approved"): void {
		const humanActor = requiredString(actor, "actor");
		if (/^(agent|system|model|classifier)(:|$)/i.test(humanActor))
			throw new Error("Only explicit human action may approve classifier memory");
		this.withTransaction(() => {
			const result = this.database
				.prepare("UPDATE memory_entries SET approval_status = ?, updated_at = ? WHERE id = ?")
				.run(status, new Date().toISOString(), requiredString(memoryId, "memoryId"));
			if (result.changes !== 1) throw new Error(`Unknown memory entry: ${memoryId}`);
		});
	}

	getMemoryEntry(memoryId: string): MemoryEntry | undefined {
		const row = this.database
			.prepare(
				"SELECT id, case_id, finding, outcome, root_cause, evidence_summary, confidence, scope, approval_status, supersedes_id, created_at, updated_at FROM memory_entries WHERE id = ?",
			)
			.get(requiredString(memoryId, "memoryId")) as Row | undefined;
		if (!row) return undefined;
		return {
			id: rowString(row, "id"),
			caseId: row.case_id == null ? undefined : rowString(row, "case_id"),
			finding: rowString(row, "finding"),
			outcome: row.outcome == null ? undefined : rowString(row, "outcome"),
			rootCause: row.root_cause == null ? undefined : rowString(row, "root_cause"),
			evidenceSummary: rowString(row, "evidence_summary"),
			confidence: Number(row.confidence),
			scope: rowString(row, "scope"),
			approvalStatus: rowString(row, "approval_status") as MemoryEntry["approvalStatus"],
			supersedesId: row.supersedes_id == null ? undefined : rowString(row, "supersedes_id"),
			createdAt: rowString(row, "created_at"),
			updatedAt: rowString(row, "updated_at"),
		};
	}

	private readQuickFixProposal(row: Row): StoredQuickFixProposal {
		const parseList = (field: string): string[] => JSON.parse(rowString(row, field)) as string[];
		return {
			id: rowString(row, "id"),
			caseId: rowString(row, "case_id"),
			workItemId: rowString(row, "work_item_id"),
			findings: rowString(row, "findings"),
			scope: rowString(row, "scope"),
			risks: parseList("risks"),
			verificationPlan: parseList("verification_plan"),
			rolloutMode: rowString(row, "rollout_mode") as RolloutMode,
			decision: rowString(row, "decision") as QuickFixProposalInput["decision"],
			decisionReason: rowString(row, "decision_reason"),
			...(row.decided_by == null ? {} : { decidedBy: rowString(row, "decided_by") }),
			createdAt: rowString(row, "created_at"),
			updatedAt: rowString(row, "updated_at"),
		};
	}

	getQuickFixProposal(caseId: string): StoredQuickFixProposal | undefined {
		const row = this.database
			.prepare("SELECT * FROM quick_fix_proposals WHERE case_id = ?")
			.get(requiredString(caseId, "caseId")) as Row | undefined;
		return row ? this.readQuickFixProposal(row) : undefined;
	}

	createQuickFixProposal(input: QuickFixProposalInput): StoredQuickFixProposal {
		const caseId = requiredString(input.caseId, "caseId");
		const findings = requiredString(input.findings, "findings");
		const scope = requiredString(input.scope, "scope");
		const list = (value: string[], field: string): string[] => {
			if (
				!Array.isArray(value) ||
				value.length === 0 ||
				value.some((item) => typeof item !== "string" || !item.trim())
			)
				throw new Error(`${field} must contain non-empty strings`);
			return value.map((item) => item.trim());
		};
		const risks = list(input.risks, "risks");
		const verificationPlan = list(input.verificationPlan, "verificationPlan");
		const existing = this.getQuickFixProposal(caseId);
		if (existing) return existing;
		const proposalId = randomUUID();
		const workItemId = randomUUID();
		const createdAt = new Date().toISOString();
		const policyDecision = input.decision === "approved" ? "admitted" : input.decision;
		this.withTransaction(() => {
			if (!this.database.prepare("SELECT id FROM cases WHERE id = ?").get(caseId))
				throw new Error(`Unknown case: ${caseId}`);
			const ordinal =
				Number(
					(
						this.database
							.prepare("SELECT coalesce(max(ordinal), 0) AS ordinal FROM work_items WHERE case_id = ?")
							.get(caseId) as Row
					).ordinal,
				) + 1;
			this.database
				.prepare(
					"INSERT INTO work_items (id, case_id, ordinal, title, scope, acceptance_criteria) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(
					workItemId,
					caseId,
					ordinal,
					`Quick fix: ${findings.slice(0, 160)}`,
					scope,
					jsonBoundary(verificationPlan, "verificationPlan"),
				);
			this.database
				.prepare(
					"INSERT INTO quick_fix_proposals (id, case_id, work_item_id, findings, scope, risks, verification_plan, decision, rollout_mode, decision_reason, decided_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					proposalId,
					caseId,
					workItemId,
					findings,
					scope,
					jsonBoundary(risks, "risks"),
					jsonBoundary(verificationPlan, "verificationPlan"),
					input.decision,
					input.rolloutMode,
					requiredString(input.decisionReason, "decisionReason"),
					input.decidedBy ?? null,
					createdAt,
					createdAt,
				);
			this.database
				.prepare(
					"INSERT INTO quick_fix_policy_decisions (id, proposal_id, case_id, mode, decision, reason, actor) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					randomUUID(),
					proposalId,
					caseId,
					input.rolloutMode,
					policyDecision,
					input.decisionReason,
					input.decidedBy ?? "controller",
				);
		});
		return this.getQuickFixProposal(caseId)!;
	}

	approveQuickFixProposal(proposalId: string, actor: string): StoredQuickFixProposal {
		const id = requiredString(proposalId, "proposalId");
		const proposal = this.get<Row>("SELECT * FROM quick_fix_proposals WHERE id = ?", id);
		if (!proposal) throw new Error(`Unknown quick-fix proposal: ${id}`);
		const now = new Date().toISOString();
		this.withTransaction(() => {
			this.database
				.prepare(
					"UPDATE quick_fix_proposals SET decision = 'approved', decision_reason = ?, decided_by = ?, updated_at = ? WHERE id = ? AND decision = 'pending'",
				)
				.run("explicit human approval", requiredString(actor, "actor"), now, id);
			this.database
				.prepare(
					"UPDATE quick_fix_policy_decisions SET decision = 'admitted', reason = ?, actor = ? WHERE proposal_id = ?",
				)
				.run("explicit human approval", actor, id);
		});
		return this.getQuickFixProposal(rowString(proposal, "case_id"))!;
	}

	createInvestigationReport(input: InvestigationReportInput): string {
		const id = randomUUID();
		this.withTransaction(() => {
			if (!this.database.prepare("SELECT id FROM cases WHERE id = ?").get(requiredString(input.caseId, "caseId")))
				throw new Error(`Unknown case: ${input.caseId}`);
			if (input.attemptId && !this.database.prepare("SELECT id FROM attempts WHERE id = ?").get(input.attemptId))
				throw new Error(`Unknown attempt: ${input.attemptId}`);
			this.database
				.prepare(
					"INSERT INTO investigation_reports (id, case_id, attempt_id, evidence, related_cases, report) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					requiredString(input.caseId, "caseId"),
					input.attemptId ?? null,
					jsonBoundary(input.evidence, "evidence"),
					jsonBoundary(input.relatedCases, "relatedCases"),
					jsonBoundary(input.report, "report"),
				);
		});
		return id;
	}

	createQuestionBrief(input: QuestionBriefInput): string {
		const id = randomUUID();
		if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 100)
			throw new Error("confidence must be between 0 and 100");
		this.withTransaction(() => {
			if (!this.database.prepare("SELECT id FROM cases WHERE id = ?").get(requiredString(input.caseId, "caseId")))
				throw new Error(`Unknown case: ${input.caseId}`);
			if (input.attemptId && !this.database.prepare("SELECT id FROM attempts WHERE id = ?").get(input.attemptId))
				throw new Error(`Unknown attempt: ${input.attemptId}`);
			this.database
				.prepare(
					"INSERT INTO question_briefs (id, case_id, attempt_id, question, findings, sources, confidence, uncertainties, limits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					requiredString(input.caseId, "caseId"),
					input.attemptId ?? null,
					requiredString(input.question, "question"),
					jsonBoundary(input.findings, "findings"),
					jsonBoundary(input.sources, "sources"),
					input.confidence,
					jsonBoundary(input.uncertainties ?? [], "uncertainties"),
					jsonBoundary(input.limits, "limits"),
				);
		});
		return id;
	}

	createSpecificationVersion(input: SpecificationVersionInput): StoredSpecificationVersion {
		const caseId = requiredString(input.caseId, "caseId");
		const materialHash = requiredString(input.materialHash, "materialHash");
		const row = this.database.prepare("SELECT id FROM cases WHERE id = ?").get(caseId);
		if (!row) throw new Error(`Unknown case: ${caseId}`);
		const latest = this.database
			.prepare("SELECT coalesce(max(version), 0) AS version FROM spec_versions WHERE case_id = ?")
			.get(caseId) as Row;
		const version = Number(latest.version) + 1;
		const id = randomUUID();
		const createdAt = new Date().toISOString();
		const decisions = input.decisions ?? [];
		const unresolvedQuestions = input.unresolvedQuestions ?? [];
		const permissions = input.permissions ?? [];
		const orderedWorkItems = input.decomposition.map(() => randomUUID());
		this.withTransaction(() => {
			this.database
				.prepare(
					"INSERT INTO spec_versions (id, case_id, version, specification, decisions, unresolved_questions, permissions, material_hash, planner_summary, decomposition, ordered_work_items, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					caseId,
					version,
					jsonBoundary(input.specification, "specification"),
					jsonBoundary(decisions, "decisions"),
					jsonBoundary(unresolvedQuestions, "unresolvedQuestions"),
					jsonBoundary(permissions, "permissions"),
					materialHash,
					input.plannerSummary ?? null,
					jsonBoundary(input.decomposition, "decomposition"),
					jsonBoundary(orderedWorkItems, "orderedWorkItems"),
					createdAt,
				);
			let parentId: string | null = null;
			const ordinalBase = Number(
				(
					this.database
						.prepare("SELECT coalesce(max(ordinal), 0) AS ordinal FROM work_items WHERE case_id = ?")
						.get(caseId) as Row
				).ordinal,
			);
			for (const [index, item] of input.decomposition.entries()) {
				this.database
					.prepare(
						"INSERT INTO work_items (id, case_id, spec_version_id, ordinal, parent_id, title, scope, acceptance_criteria) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						orderedWorkItems[index],
						caseId,
						id,
						ordinalBase + item.order,
						parentId,
						item.title,
						item.scope,
						jsonBoundary(item.acceptanceCriteria, "acceptanceCriteria"),
					);
				parentId = orderedWorkItems[index] ?? null;
			}
		});
		return {
			id,
			caseId,
			version,
			specification: input.specification,
			decisions,
			unresolvedQuestions,
			permissions,
			decomposition: input.decomposition,
			orderedWorkItems,
			...(input.plannerSummary === undefined ? {} : { plannerSummary: input.plannerSummary }),
			materialHash,
			createdAt,
		};
	}

	getLatestSpecification(caseId: string): StoredSpecificationVersion | undefined {
		const row = this.database
			.prepare(
				"SELECT id, case_id, version, specification, decisions, unresolved_questions, permissions, material_hash, planner_summary, decomposition, ordered_work_items, created_at FROM spec_versions WHERE case_id = ? ORDER BY version DESC LIMIT 1",
			)
			.get(requiredString(caseId, "caseId")) as Row | undefined;
		return row ? this.readSpecification(row) : undefined;
	}

	getSpecification(caseId: string, version: number): StoredSpecificationVersion | undefined {
		const row = this.database
			.prepare(
				"SELECT id, case_id, version, specification, decisions, unresolved_questions, permissions, material_hash, planner_summary, decomposition, ordered_work_items, created_at FROM spec_versions WHERE case_id = ? AND version = ?",
			)
			.get(requiredString(caseId, "caseId"), version) as Row | undefined;
		return row ? this.readSpecification(row) : undefined;
	}

	private readSpecification(row: Row): StoredSpecificationVersion {
		const parse = (field: string): unknown => {
			try {
				return JSON.parse(rowString(row, field));
			} catch (error) {
				throw new Error(`Stored specification ${field} contains invalid JSON`, { cause: error });
			}
		};
		return {
			id: rowString(row, "id"),
			caseId: rowString(row, "case_id"),
			version: Number(row.version),
			specification: parse("specification"),
			decisions: parse("decisions") as unknown[],
			unresolvedQuestions: parse("unresolved_questions") as unknown[],
			permissions: parse("permissions"),
			decomposition: parse("decomposition") as SpecificationWorkItem[],
			orderedWorkItems: parse("ordered_work_items") as string[],
			materialHash: rowString(row, "material_hash"),
			...(row.planner_summary == null ? {} : { plannerSummary: rowString(row, "planner_summary") }),
			createdAt: rowString(row, "created_at"),
		};
	}

	recordSpecificationApproval(input: SpecificationApprovalInput): string {
		const caseId = requiredString(input.caseId, "caseId");
		const actor = requiredString(input.actor, "actor");
		if (!Number.isSafeInteger(input.specVersion) || input.specVersion <= 0)
			throw new Error("specVersion must be a positive integer");
		if (!input.permissions.every((permission) => typeof permission === "string" && permission.trim() !== ""))
			throw new Error("permissions must contain non-empty strings");
		const approvalId = randomUUID();
		this.withTransaction(() => {
			const current = this.database
				.prepare(
					"SELECT id, version, material_hash FROM spec_versions WHERE case_id = ? ORDER BY version DESC LIMIT 1",
				)
				.get(caseId) as Row | undefined;
			if (!current || Number(current.version) !== input.specVersion)
				throw new Error(`Specification approval is not for the current version of ${caseId}`);
			if (rowString(current, "material_hash") !== input.materialHash)
				throw new Error(`Specification approval material is stale for ${caseId}`);
			const workItems = input.orderedWorkItems;
			const unique = new Set(workItems);
			if (unique.size !== workItems.length) throw new Error("orderedWorkItems must not contain duplicates");
			for (const workItemId of workItems) {
				const item = this.database
					.prepare("SELECT id FROM work_items WHERE id = ? AND case_id = ?")
					.get(workItemId, caseId);
				if (!item) throw new Error(`Unknown work item for specification: ${workItemId}`);
			}
			this.database
				.prepare(
					"INSERT INTO approvals (id, spec_version_id, decision, actor, permissions, material_hash, spec_version, frozen_permissions, ordered_work_items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					approvalId,
					rowString(current, "id"),
					input.decision ?? "approved",
					actor,
					jsonBoundary(input.permissions, "permissions"),
					input.materialHash,
					input.specVersion,
					jsonBoundary(input.permissions, "frozenPermissions"),
					jsonBoundary(workItems, "orderedWorkItems"),
				);
		});
		return approvalId;
	}

	createFreshPlannerAttempt(input: { caseId: string; priority?: number; workItemId?: string }): {
		jobId: string;
		attemptId: string;
	} {
		const jobId = randomUUID();
		const attemptId = randomUUID();
		const caseId = requiredString(input.caseId, "caseId");
		this.withTransaction(() => {
			if (!this.database.prepare("SELECT id FROM cases WHERE id = ?").get(caseId))
				throw new Error(`Unknown case: ${caseId}`);
			this.database
				.prepare("INSERT INTO jobs (id, case_id, work_item_id, role, priority) VALUES (?, ?, ?, 'spec-planner', ?)")
				.run(jobId, caseId, input.workItemId ?? null, input.priority ?? 0);
			this.database
				.prepare(
					"INSERT INTO attempts (id, job_id, case_id, role, generation, state) VALUES (?, ?, ?, 'spec-planner', 1, 'queued')",
				)
				.run(attemptId, jobId, caseId);
		});
		return { jobId, attemptId };
	}

	recordSpecificationFeedback(input: { caseId: string; specVersion: number; feedback: string; actor: string }): {
		feedbackId: string;
		jobId: string;
		attemptId: string;
	} {
		const caseId = requiredString(input.caseId, "caseId");
		const actor = requiredString(input.actor, "actor");
		if (/^(agent|system|model|classifier)(:|$)/i.test(actor))
			throw new Error("Specification feedback requires an explicit human actor");
		if (!Number.isSafeInteger(input.specVersion) || input.specVersion <= 0)
			throw new Error("specVersion must be a positive integer");
		const feedbackId = randomUUID();
		const jobId = randomUUID();
		const attemptId = randomUUID();
		this.withTransaction(() => {
			const current = this.database
				.prepare("SELECT version FROM spec_versions WHERE case_id = ? ORDER BY version DESC LIMIT 1")
				.get(caseId) as Row | undefined;
			if (!current || Number(current.version) !== input.specVersion)
				throw new Error(`Specification feedback is not for the current version of ${caseId}`);
			this.database
				.prepare(
					"INSERT INTO specification_feedback (id, case_id, spec_version, feedback, actor) VALUES (?, ?, ?, ?, ?)",
				)
				.run(feedbackId, caseId, input.specVersion, requiredString(input.feedback, "feedback"), actor);
			this.database
				.prepare("INSERT INTO jobs (id, case_id, role, priority) VALUES (?, ?, 'spec-planner', 0)")
				.run(jobId, caseId);
			this.database
				.prepare(
					"INSERT INTO attempts (id, job_id, case_id, role, generation, state) VALUES (?, ?, ?, 'spec-planner', 1, 'queued')",
				)
				.run(attemptId, jobId, caseId);
		});
		return { feedbackId, jobId, attemptId };
	}

	recordTrustedCheckpoint(input: TrustedCheckpointInput): string {
		const id = randomUUID();
		const createdAt = utcTimestamp(input.createdAt, "createdAt");
		this.withTransaction(() => {
			const attemptId = requiredString(input.attemptId, "attemptId");
			if (!this.database.prepare("SELECT id FROM attempts WHERE id = ?").get(attemptId))
				throw new Error(`Unknown attempt: ${attemptId}`);
			this.database
				.prepare(
					"INSERT INTO recovery_checkpoints (id, attempt_id, kind, path, digest, metadata, created_at, trusted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					attemptId,
					requiredString(input.kind, "kind"),
					input.path ?? null,
					input.digest ?? null,
					jsonBoundary(input.metadata ?? {}, "checkpoint metadata"),
					createdAt,
					createdAt,
				);
		});
		return id;
	}

	latestTrustedCheckpoint(jobId: string): TrustedCheckpoint | undefined {
		const row = this.database
			.prepare(
				"SELECT c.id, c.attempt_id, c.kind, c.path, c.digest, c.metadata, c.created_at FROM recovery_checkpoints c JOIN attempts a ON a.id = c.attempt_id WHERE a.job_id = ? ORDER BY c.trusted_at DESC, c.id DESC LIMIT 1",
			)
			.get(requiredString(jobId, "jobId")) as Row | undefined;
		return row ? this.readTrustedCheckpoint(row) : undefined;
	}

	trustedCheckpoint(checkpointId: string): TrustedCheckpoint | undefined {
		const row = this.database
			.prepare(
				"SELECT id, attempt_id, kind, path, digest, metadata, created_at FROM recovery_checkpoints WHERE id = ?",
			)
			.get(requiredString(checkpointId, "checkpointId")) as Row | undefined;
		return row ? this.readTrustedCheckpoint(row) : undefined;
	}

	private readTrustedCheckpoint(row: Row): TrustedCheckpoint {
		let metadata: unknown = {};
		try {
			metadata = JSON.parse(rowString(row, "metadata"));
		} catch (error) {
			throw new Error("Stored checkpoint metadata contains invalid JSON", { cause: error });
		}
		return {
			id: rowString(row, "id"),
			attemptId: rowString(row, "attempt_id"),
			kind: rowString(row, "kind"),
			path: row.path == null ? undefined : rowString(row, "path"),
			digest: row.digest == null ? undefined : rowString(row, "digest"),
			metadata,
			createdAt: rowString(row, "created_at"),
		};
	}

	recordRecoveryDecision(input: RecoveryDecisionInput): string {
		const id = randomUUID();
		const createdAt = utcTimestamp(input.createdAt, "createdAt");
		this.withTransaction(() => {
			this.database
				.prepare(
					"INSERT INTO recovery_decisions (id, attempt_id, decision, reason, systemd_state, worktree_state, checkpoint_id, replacement_attempt_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					requiredString(input.attemptId, "attemptId"),
					requiredString(input.decision, "decision"),
					requiredString(input.reason, "reason"),
					input.systemdState ?? null,
					input.worktreeState ?? null,
					input.checkpointId ?? null,
					input.replacementAttemptId ?? null,
					jsonBoundary(input.metadata ?? {}, "recovery metadata"),
					createdAt,
				);
		});
		return id;
	}

	/** Preserve a stale attempt and queue its next generation for normal provider assignment. */
	queueReplacementAttempt(attemptId: string, checkpointId: string, now = new Date()): QueuedRecovery | null {
		const timestamp = utcTimestamp(now, "now");
		return this.withTransaction(() => {
			const attempt = this.database
				.prepare("SELECT job_id, case_id, role, state FROM attempts WHERE id = ?")
				.get(attemptId) as Row | undefined;
			if (!attempt) throw new Error(`Unknown attempt: ${attemptId}`);
			if (rowString(attempt, "state") !== "running") return null;
			if (!this.database.prepare("SELECT id FROM recovery_checkpoints WHERE id = ?").get(checkpointId))
				throw new Error(`Unknown checkpoint: ${checkpointId}`);
			this.database
				.prepare(
					"UPDATE attempts SET state = 'failed', failure = ?, finished_at = ? WHERE id = ? AND state = 'running'",
				)
				.run("replaced during recovery", timestamp, attemptId);
			this.database.prepare("DELETE FROM attempt_leases WHERE attempt_id = ?").run(attemptId);
			this.database
				.prepare(
					"UPDATE jobs SET state = 'queued', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?",
				)
				.run(timestamp, rowString(attempt, "job_id"));
			const previous = this.database
				.prepare("SELECT coalesce(max(generation), 0) AS generation FROM attempts WHERE job_id = ?")
				.get(rowString(attempt, "job_id")) as Row;
			const generation = Number(previous.generation) + 1;
			const replacementAttemptId = randomUUID();
			this.database
				.prepare(
					"INSERT INTO attempts (id, job_id, case_id, role, generation, state, recovery_checkpoint_id) VALUES (?, ?, ?, ?, ?, 'queued', ?)",
				)
				.run(
					replacementAttemptId,
					rowString(attempt, "job_id"),
					rowString(attempt, "case_id"),
					rowString(attempt, "role"),
					generation,
					checkpointId,
				);
			return { jobId: rowString(attempt, "job_id"), attemptId: replacementAttemptId, generation };
		});
	}

	markAttemptNeedsHuman(attemptId: string, reason: string, now = new Date()): boolean {
		const timestamp = utcTimestamp(now, "now");
		return this.withTransaction(() => {
			const attempt = this.get<{ job_id: string }>(
				"SELECT job_id FROM attempts WHERE id = ? AND state = 'running'",
				attemptId,
			);
			if (!attempt) return false;
			this.run(
				"UPDATE attempts SET state = 'needs-human', failure = ?, finished_at = ? WHERE id = ? AND state = 'running'",
				reason,
				timestamp,
				attemptId,
			);
			this.run("DELETE FROM attempt_leases WHERE attempt_id = ?", attemptId);
			this.run(
				"UPDATE jobs SET state = 'needs-human', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND state = 'running'",
				timestamp,
				attempt.job_id,
			);
			return true;
		});
	}
}

export function openBackgroundAgentsDatabase(path: string, options?: DatabaseOptions): BackgroundAgentsDatabase {
	return new BackgroundAgentsDatabase(path, options);
}
