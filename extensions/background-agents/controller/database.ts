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
	classified: ["investigating", "question-analysis", "specification", "paused", "cancelled"],
	investigating: ["question-analysis", "specification", "awaiting-approval", "paused", "cancelled"],
	"question-analysis": ["investigating", "handled", "paused", "cancelled"],
	specification: ["awaiting-approval", "paused", "cancelled"],
	"awaiting-approval": ["specification", "implementation", "paused", "cancelled"],
	implementation: ["verification", "retry", "blocked", "paused", "paused-usage", "cancelled"],
	verification: ["pull-request-review", "handled", "retry", "blocked", "paused", "paused-usage", "cancelled"],
	"pull-request-review": ["handled", "retry", "blocked", "paused", "cancelled"],
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
	"paused-usage": ["implementation", "verification", "retry", "cancelled"],
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
}

export interface JobClaim {
	jobId: string;
	attemptId: string;
	leaseId: string;
	generation: number;
	expiresAt: string;
	profileId?: string;
	model?: string;
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
	createdAt: string;
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

export interface InvestigationReportInput {
	caseId: string;
	attemptId?: string;
	evidence: unknown;
	relatedCases: unknown[];
	report: unknown;
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
	};
	replayOf?: string;
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

	withTransaction<T>(callback: () => T): T {
		if (this.database.isTransaction) throw new Error("A database transaction is already active");
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
			if (existing)
				return { eventId: rowString(existing, "id"), caseId: rowString(existing, "case_id"), inserted: false };

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

	createVerificationRun(input: VerificationRunInput): string {
		const id = input.id ?? randomUUID();
		this.withTransaction(() => {
			this.database
				.prepare(
					"INSERT INTO verification_runs (id, manifest_id, verdict, confidence, ci_checks, rationale, uncertainties, actual_results, replay_history, replay_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
					input.replayOf ?? null,
				);
		});
		return id;
	}

	listVerificationRuns(manifestId: string): VerificationRun[] {
		return this.database
			.prepare(
				"SELECT id, manifest_id, verdict, confidence, ci_checks, rationale, uncertainties, created_at, replay_history FROM verification_runs WHERE manifest_id = ? ORDER BY created_at, rowid",
			)
			.all(manifestId)
			.map((row) => ({
				id: rowString(row as Row, "id"),
				manifestId: rowString(row as Row, "manifest_id"),
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
				createdAt: rowString(row as Row, "created_at"),
			}));
	}

	createJob(input: JobInput): string {
		const id = input.id ?? randomUUID();
		this.withTransaction(() => {
			this.database
				.prepare("INSERT INTO jobs (id, case_id, work_item_id, role, priority) VALUES (?, ?, ?, ?, ?)")
				.run(
					id,
					requiredString(input.caseId, "caseId"),
					input.workItemId ?? null,
					role(input.role),
					input.priority ?? 0,
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
						"UPDATE attempts SET state = 'running', profile_id = ?, model = ?, heartbeat_at = ?, started_at = ? WHERE id = ? AND state = 'queued'",
					)
					.run(assignment?.profileId ?? null, assignment?.model ?? null, claimedAt, claimedAt, attemptId);
			} else {
				this.database
					.prepare(
						"INSERT INTO attempts (id, job_id, case_id, role, generation, state, profile_id, model, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)",
					)
					.run(
						attemptId,
						jobId,
						rowString(job, "case_id"),
						rowString(job, "role"),
						generation,
						assignment?.profileId ?? null,
						assignment?.model ?? null,
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
		this.withTransaction(() => {
			this.database
				.prepare(
					"INSERT INTO spec_versions (id, case_id, version, specification, decisions, unresolved_questions, permissions, material_hash, planner_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
					createdAt,
				);
		});
		return {
			id,
			caseId,
			version,
			specification: input.specification,
			decisions,
			unresolvedQuestions,
			permissions,
			...(input.plannerSummary === undefined ? {} : { plannerSummary: input.plannerSummary }),
			materialHash,
			createdAt,
		};
	}

	getLatestSpecification(caseId: string): StoredSpecificationVersion | undefined {
		const row = this.database
			.prepare(
				"SELECT id, case_id, version, specification, decisions, unresolved_questions, permissions, material_hash, planner_summary, created_at FROM spec_versions WHERE case_id = ? ORDER BY version DESC LIMIT 1",
			)
			.get(requiredString(caseId, "caseId")) as Row | undefined;
		return row ? this.readSpecification(row) : undefined;
	}

	getSpecification(caseId: string, version: number): StoredSpecificationVersion | undefined {
		const row = this.database
			.prepare(
				"SELECT id, case_id, version, specification, decisions, unresolved_questions, permissions, material_hash, planner_summary, created_at FROM spec_versions WHERE case_id = ? AND version = ?",
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
				"SELECT c.id, c.attempt_id, c.kind, c.path, c.digest, c.created_at FROM recovery_checkpoints c JOIN attempts a ON a.id = c.attempt_id WHERE a.job_id = ? ORDER BY c.trusted_at DESC, c.id DESC LIMIT 1",
			)
			.get(requiredString(jobId, "jobId")) as Row | undefined;
		if (!row) return undefined;
		return {
			id: rowString(row, "id"),
			attemptId: rowString(row, "attempt_id"),
			kind: rowString(row, "kind"),
			path: row.path == null ? undefined : rowString(row, "path"),
			digest: row.digest == null ? undefined : rowString(row, "digest"),
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

	replaceAttempt(attemptId: string, owner: string, leaseMs = DEFAULT_LEASE_MS, now = new Date()): JobClaim | null {
		const timestamp = utcTimestamp(now, "now");
		if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be a positive integer");
		return this.withTransaction(() => {
			const attempt = this.database
				.prepare("SELECT job_id, case_id, role, state FROM attempts WHERE id = ?")
				.get(attemptId) as Row | undefined;
			if (!attempt) throw new Error(`Unknown attempt: ${attemptId}`);
			if (rowString(attempt, "state") !== "running") return null;
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
			const leaseId = randomUUID();
			const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
			this.database
				.prepare(
					"INSERT INTO attempts (id, job_id, case_id, role, generation, state, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)",
				)
				.run(
					replacementAttemptId,
					rowString(attempt, "job_id"),
					rowString(attempt, "case_id"),
					rowString(attempt, "role"),
					generation,
					timestamp,
					timestamp,
				);
			this.database
				.prepare(
					"INSERT INTO attempt_leases (id, attempt_id, owner, generation, expires_at, last_renewed_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(leaseId, replacementAttemptId, requiredString(owner, "owner"), generation, expiresAt, timestamp);
			this.database
				.prepare("UPDATE jobs SET state = 'running', claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?")
				.run(owner, timestamp, timestamp, rowString(attempt, "job_id"));
			return {
				jobId: rowString(attempt, "job_id"),
				attemptId: replacementAttemptId,
				leaseId,
				generation,
				expiresAt,
			};
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
