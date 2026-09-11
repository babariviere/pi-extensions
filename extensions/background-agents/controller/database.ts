import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync as NativeDatabaseSync } from "node:sqlite";
import type { AgentRole, BackgroundSource, CaseState, Classification, RolloutMode, SourceEvent } from "../types.ts";
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

export interface PolicyInput {
	id?: string;
	scope: string;
	version: string;
	policy: unknown;
	proposedBy: string;
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
		const caseSource = source(event.source);
		const sourceKey = requiredString(event.sourceKey, "sourceKey");
		const revision = event.revision ?? "";
		const receivedAt = utcTimestamp(event.receivedAt, "receivedAt");
		const title = requiredString(event.title, "title");
		const body = typeof event.body === "string" ? event.body : requiredString(event.body, "body");
		const metadata = jsonBoundary(event.metadata ?? {}, "metadata");
		return this.withTransaction(() => {
			const existing = this.database
				.prepare("SELECT id, case_id FROM source_events WHERE source = ? AND source_key = ? AND revision = ?")
				.get(caseSource, sourceKey, revision) as Row | undefined;
			if (existing)
				return { eventId: rowString(existing, "id"), caseId: rowString(existing, "case_id"), inserted: false };

			const caseId = options.caseId ?? randomUUID();
			if (options.caseId) {
				const found = this.database.prepare("SELECT id FROM cases WHERE id = ?").get(caseId);
				if (!found) throw new Error(`Unknown case: ${caseId}`);
			} else {
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
		});
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

	claimJob(jobId: string, owner: string, leaseMs = DEFAULT_LEASE_MS, now = new Date()): JobClaim | null {
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
			const previous = this.database
				.prepare("SELECT coalesce(max(generation), 0) AS generation FROM attempts WHERE job_id = ?")
				.get(jobId) as Row;
			const generation = Number(previous.generation) + 1;
			const attemptId = randomUUID();
			const leaseId = randomUUID();
			const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
			this.database
				.prepare(
					"INSERT INTO attempts (id, job_id, case_id, role, generation, state, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)",
				)
				.run(attemptId, jobId, rowString(job, "case_id"), rowString(job, "role"), generation, claimedAt, claimedAt);
			this.database
				.prepare(
					"INSERT INTO attempt_leases (id, attempt_id, owner, generation, expires_at, last_renewed_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(leaseId, attemptId, requiredString(owner, "owner"), generation, expiresAt, claimedAt);
			this.database
				.prepare("UPDATE jobs SET state = 'running', claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?")
				.run(owner, claimedAt, claimedAt, jobId);
			return { jobId, attemptId, leaseId, generation, expiresAt };
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

	activatePolicy(policyId: string, actor: string, now = new Date()): void {
		const activatedAt = utcTimestamp(now, "now");
		this.withTransaction(() => {
			const policy = this.database
				.prepare("SELECT scope, status FROM classifier_policies WHERE id = ?")
				.get(policyId) as Row | undefined;
			if (!policy) throw new Error(`Unknown classifier policy: ${policyId}`);
			if (rowString(policy, "status") === "retired")
				throw new Error(`Cannot activate retired classifier policy: ${policyId}`);
			this.database
				.prepare(
					"UPDATE classifier_policies SET status = 'retired', activated_at = NULL WHERE scope = ? AND status = 'active'",
				)
				.run(rowString(policy, "scope"));
			this.database
				.prepare(
					"UPDATE classifier_policies SET status = 'active', activated_by = ?, activated_at = ? WHERE id = ?",
				)
				.run(requiredString(actor, "actor"), activatedAt, policyId);
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
}

export function openBackgroundAgentsDatabase(path: string, options?: DatabaseOptions): BackgroundAgentsDatabase {
	return new BackgroundAgentsDatabase(path, options);
}
