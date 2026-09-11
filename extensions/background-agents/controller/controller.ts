import { readFileSync } from "node:fs";
import type {
	AgentRole,
	AttemptState,
	BackgroundAgentsConfig,
	BackgroundSource,
	CaseAction,
	DashboardSnapshot,
	RolloutMode,
	SourceEvent,
} from "../types.ts";
import type { BackgroundRequest, BackgroundResponse } from "../protocol.ts";
import { validateBackgroundRequest } from "../protocol.ts";
import { normalizeBackgroundAgentsConfig, validateBackgroundAgentsConfig, type CredentialStat } from "../config.ts";
import { BackgroundAgentsDatabase, type JobClaim, type SourceEventResult } from "./database.ts";
import { ManualSourceAdapter, type ManualSubmission } from "./sources/manual.ts";
import { SlackSourceAdapter } from "./sources/slack.ts";
import { LinearSourceAdapter, type LinearGraphqlClient } from "./sources/linear.ts";
import { DatadogSourceAdapter, type DatadogClient } from "./sources/datadog.ts";
import type { SourceAdapter, SourceStore } from "./sources/source.ts";
import { Classifier, type ClassifierLauncher } from "./classification/classifier.ts";
import { recordOperatorFeedback } from "./classification/feedback.ts";
import { JobScheduler } from "./jobs.ts";
import { ProviderScheduler } from "./providers/scheduler.ts";
import { RecoveryCoordinator } from "./recovery.ts";
import { createSqliteBackup } from "./backup.ts";
import { BackgroundAgentsStateMachine } from "./state-machine.ts";
import { QuestionWorkflow } from "./workflows/question.ts";
import { SpecificationWorkflow } from "./workflows/specification.ts";
import { reproduceEvidenceOperation } from "./verification/reproduce.ts";
import { BackgroundSocketServer } from "./socket-server.ts";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
function credentialObject(path: string | undefined): Record<string, unknown> {
	if (!path) throw new Error("a credential file reference is required");
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value === "string") return { token: value };
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("credential file must contain an object");
		return value as Record<string, unknown>;
	} catch (error) {
		throw new Error(`unable to read credential file ${path}`, { cause: error });
	}
}
function credentialValue(credentials: Record<string, unknown>, names: readonly string[]): string {
	for (const name of names)
		if (typeof credentials[name] === "string" && (credentials[name] as string).trim())
			return (credentials[name] as string).trim();
	throw new Error("credential file does not contain the required credential");
}
async function jsonResponse(response: Response, service: string): Promise<Record<string, unknown>> {
	if (!response.ok) throw new Error(`${service} request failed with HTTP ${response.status}`);
	const value: unknown = await response.json();
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${service} returned a non-object response`);
	return value as Record<string, unknown>;
}
export class SlackConnectionsClient {
	constructor(
		private readonly url: string,
		private readonly credentialPath: string,
		private readonly fetcher: FetchLike = fetch,
	) {}
	async open(): Promise<string> {
		const token = credentialValue(credentialObject(this.credentialPath), ["token", "appToken", "accessToken"]);
		const result = await jsonResponse(
			await this.fetcher(this.url, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
			}),
			"Slack apps.connections.open",
		);
		if (result.ok !== true || typeof result.url !== "string" || !result.url)
			throw new Error("Slack did not return a Socket Mode URL");
		return result.url;
	}
}
export class LinearHttpClient implements LinearGraphqlClient {
	constructor(
		private readonly url: string,
		private readonly credentialPath: string,
		private readonly fetcher: FetchLike = fetch,
	) {}
	async query<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
		const token = credentialValue(credentialObject(this.credentialPath), ["token", "apiKey", "accessToken"]);
		const result = await jsonResponse(
			await this.fetcher(this.url, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ query, variables }),
			}),
			"Linear GraphQL",
		);
		if (Array.isArray(result.errors) && result.errors.length > 0) throw new Error("Linear GraphQL returned errors");
		return result as T;
	}
}
export class DatadogHttpClient implements DatadogClient {
	private readonly baseUrl: string;
	private readonly credentials: Record<string, unknown>;
	constructor(
		url: string,
		credentialPath: string,
		private readonly fetcher: FetchLike = fetch,
	) {
		this.baseUrl = url.replace(/\/$/, "");
		this.credentials = credentialObject(credentialPath);
	}
	private headers(): Record<string, string> {
		return {
			"DD-API-KEY": credentialValue(this.credentials, ["apiKey", "api_key", "key"]),
			"DD-APPLICATION-KEY": credentialValue(this.credentials, ["appKey", "applicationKey", "application_key"]),
			"content-type": "application/json",
		};
	}
	async queryMonitors(query: string, from: string, to: string): Promise<Record<string, unknown>> {
		const params = new URLSearchParams({ query, from, to });
		const result = await jsonResponse(
			await this.fetcher(`${this.baseUrl}/api/v1/monitor/search?${params}`, { headers: this.headers() }),
			"Datadog monitor search",
		);
		return Array.isArray(result.monitors) ? { results: result.monitors } : result;
	}
	async queryErrors(query: string, from: string, to: string): Promise<Record<string, unknown>> {
		const result = await jsonResponse(
			await this.fetcher(`${this.baseUrl}/api/v2/logs/events/search`, {
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({ filter: { query, from, to }, page: { limit: 1000 } }),
			}),
			"Datadog error search",
		);
		return Array.isArray(result.data) ? { results: result.data } : result;
	}
}
export interface AttemptRunnerResult {
	state: "succeeded" | "failed" | "cancelled" | "paused" | "needs-human";
	failure?: string;
}
export interface AttemptRunner {
	run(claim: JobClaim, database: BackgroundAgentsDatabase): Promise<AttemptRunnerResult>;
}
export interface BackgroundControllerOptions {
	config?: BackgroundAgentsConfig;
	database?: BackgroundAgentsDatabase;
	owner?: string;
	operator?: string;
	fetcher?: FetchLike;
	classifierLaunch?: ClassifierLauncher;
	sources?: readonly SourceAdapter[];
	attemptRunner?: AttemptRunner;
	ciReconcile?: () => Promise<void>;
	paneFocus?: (paneId: string) => Promise<void> | void;
	startSocket?: boolean;
	clock?: () => Date;
	credentialStat?: CredentialStat;
}
function defaultClassifier(event: SourceEvent) {
	const text = `${event.title}\n${event.body}`.toLowerCase();
	if (text.includes("?") || /\bhow\b|\bwhy\b/.test(text))
		return {
			inputKind: "question" as const,
			actionability: 70,
			noise: 0,
			confidence: 80,
			rationale: "question-like input",
		};
	if (/\bfeature\b|\brequest\b|\benhancement\b/.test(text))
		return {
			inputKind: "feature" as const,
			actionability: 80,
			noise: 0,
			confidence: 75,
			rationale: "feature-like input",
		};
	return {
		inputKind: "bug-report" as const,
		actionability: 80,
		noise: 0,
		confidence: 75,
		rationale: "actionable report",
	};
}

export class BackgroundAgentsController {
	readonly database: BackgroundAgentsDatabase;
	readonly config: BackgroundAgentsConfig;
	private readonly owner: string;
	private readonly operator: string;
	private readonly sourceAdapters: SourceAdapter[];
	private readonly manual: ManualSourceAdapter;
	private readonly classifier: Classifier;
	private readonly jobs: JobScheduler;
	private readonly providerScheduler: ProviderScheduler;
	private readonly recovery: RecoveryCoordinator;
	private readonly stateMachine: BackgroundAgentsStateMachine;
	private readonly questions: QuestionWorkflow;
	private readonly specifications: SpecificationWorkflow;
	private readonly options: BackgroundControllerOptions;
	private readonly timers: ReturnType<typeof setInterval>[] = [];
	private readonly runtimeRollout: BackgroundAgentsConfig["rollout"];
	private socket?: BackgroundSocketServer;
	private started = false;
	private stopping = false;
	constructor(options: BackgroundControllerOptions = {}) {
		this.options = options;
		this.config = options.config ?? normalizeBackgroundAgentsConfig({});
		validateBackgroundAgentsConfig(this.config, { checkPaths: true, credentialStat: options.credentialStat });
		this.database = options.database ?? new BackgroundAgentsDatabase(this.config.databasePath);
		this.owner = options.owner?.trim() || `background-controller-${process.pid}`;
		this.operator = options.operator?.trim() || "socket-owner";
		this.runtimeRollout = {
			defaultMode: this.config.rollout.defaultMode,
			sourceOverrides: { ...this.config.rollout.sourceOverrides },
			repositoryOverrides: { ...this.config.rollout.repositoryOverrides },
		};
		const store: SourceStore = {
			recordSourceEvent: (event, sourceOptions) => {
				const result = this.database.recordSourceEvent(event, {
					...sourceOptions,
					rolloutMode: sourceOptions?.rolloutMode ?? this.rolloutFor(event.source, event.repository),
				});
				if (result.inserted) void this.processSourceEvent(result, event);
				return result;
			},
			recordSourceEventAndAdvanceCursor: (event, cursor, sourceOptions) => {
				const result = this.database.recordSourceEventAndAdvanceCursor(event, cursor, {
					...sourceOptions,
					rolloutMode: sourceOptions?.rolloutMode ?? this.rolloutFor(event.source, event.repository),
				});
				if (result.inserted) void this.processSourceEvent(result, event);
				return result;
			},
			setSourceCursor: (source, cursor, revision) => this.database.setSourceCursor(source, cursor, revision),
			getSourceCursor: (source) => this.database.getSourceCursor(source),
		};
		this.manual = new ManualSourceAdapter({ store });
		this.classifier = new Classifier({
			database: this.database,
			launch: options.classifierLaunch ?? (async ({ event }) => defaultClassifier(event)),
			modelVersion: this.config.classifier.modelVersion,
			thresholds: this.config.thresholds,
			policyScope: this.config.classifier.policyScope,
			exampleLimit: this.config.classifier.exampleLimit,
			relatedCaseLimit: this.config.classifier.relatedCaseLimit,
		});
		this.jobs = new JobScheduler(this.database);
		this.providerScheduler = new ProviderScheduler(this.database, this.config);
		this.recovery = new RecoveryCoordinator(this.database, { owner: this.owner });
		this.stateMachine = new BackgroundAgentsStateMachine(this.database);
		this.questions = new QuestionWorkflow(this.database);
		this.specifications = new SpecificationWorkflow(this.database);
		this.sourceAdapters = [...(options.sources ?? this.productionSources(store))];
	}
	private productionSources(store: SourceStore): SourceAdapter[] {
		const fetcher = this.options.fetcher ?? fetch;
		const sources: SourceAdapter[] = [];
		const slack = this.config.sources.slack;
		if (slack.enabled && slack.credentialPath) {
			const client = new SlackConnectionsClient(slack.url, slack.credentialPath, fetcher);
			sources.push(
				new SlackSourceAdapter({
					store,
					reconnectMs: this.config.pollIntervalsMs.slackReconnect,
					getConnectionUrl: () => client.open(),
				}),
			);
		}
		const linear = this.config.sources.linear;
		if (linear.enabled && linear.credentialPath)
			sources.push(
				new LinearSourceAdapter({
					store,
					client: new LinearHttpClient(linear.url, linear.credentialPath, fetcher),
					pageSize: linear.pageSize,
					repositoryMappings: linear.repositoryMappings,
					query: linear.query,
				}),
			);
		const datadog = this.config.sources.datadog;
		if (datadog.enabled && datadog.credentialPath)
			sources.push(
				new DatadogSourceAdapter({
					store,
					client: new DatadogHttpClient(datadog.url, datadog.credentialPath, fetcher),
					monitorQueries: datadog.monitorQueries,
					errorQueries: datadog.errorQueries,
					overlapMs: datadog.overlapMs,
					repositoryMappings: datadog.repositoryMappings,
				}),
			);
		return sources;
	}
	private rolloutFor(source: BackgroundSource, repository?: string): RolloutMode {
		return (
			(repository ? this.runtimeRollout.repositoryOverrides[repository] : undefined) ??
			this.runtimeRollout.sourceOverrides[source] ??
			this.runtimeRollout.defaultMode
		);
	}
	private async processSourceEvent(result: SourceEventResult, event: SourceEvent): Promise<void> {
		try {
			const classification = await this.classifier.classify(result.caseId, event);
			const current = this.database.get<{ state: string }>(
				"SELECT state FROM cases WHERE id = ?",
				result.caseId,
			)?.state;
			if (current === "intake")
				this.database.transitionCase(result.caseId, "classified", "classifier", "input classified");
			if (classification.classification.inputKind === "question") {
				if (this.rolloutFor(event.source, event.repository) === "observe")
					this.questions.start(result.caseId, event.body, { maxTimeMs: 60_000, maxCostUsd: 0, maxResults: 10 });
				else this.queueInvestigation(result.caseId);
			} else if (
				classification.classification.disposition === "actionable" &&
				this.rolloutFor(event.source, event.repository) !== "observe"
			)
				this.queueInvestigation(result.caseId);
		} catch {
			/* failed classification remains durably ingested */
		}
	}
	private queueInvestigation(caseId: string): void {
		const state = this.database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", caseId)?.state;
		if (state === "classified")
			this.database.transitionCase(caseId, "investigating", "controller", "investigation queued");
		if (
			!this.database.get(
				"SELECT id FROM jobs WHERE case_id = ? AND role = 'investigator' AND state IN ('queued', 'running')",
				caseId,
			)
		)
			this.database.createJob({ caseId, role: "investigator" });
	}
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.stopping = false;
		if (this.options.startSocket !== false) {
			this.socket = new BackgroundSocketServer({ ...this.config.socket, handle: (request) => this.handle(request) });
			await this.socket.start();
		}
		await this.refreshUsage();
		for (const source of this.sourceAdapters)
			if (source.start)
				try {
					await source.start();
				} catch {
					// Outbound adapters own their reconnect policy; a transient outage must not stop the controller.
				}
		await this.pollSources();
		this.timers.push(
			setInterval(() => void this.refreshUsage(), this.config.controller.usageMs),
			setInterval(() => void this.schedulerTick(), this.config.controller.schedulerMs),
			setInterval(() => void this.heartbeatTick(), this.config.controller.heartbeatMs),
			setInterval(() => void this.recoveryTick(), this.config.controller.recoveryMs),
			setInterval(() => void this.ciTick(), this.config.controller.ciMs),
			setInterval(() => void this.backupTick(), this.config.backup.intervalMs),
		);
		if (this.sourceAdapters.some((source) => source.source === "linear" && source.poll))
			this.timers.push(setInterval(() => void this.pollSources("linear"), this.config.pollIntervalsMs.linear));
		if (this.sourceAdapters.some((source) => source.source === "datadog" && source.poll))
			this.timers.push(setInterval(() => void this.pollSources("datadog"), this.config.pollIntervalsMs.datadog));
	}
	async stop(): Promise<void> {
		if (!this.started || this.stopping) return;
		this.stopping = true;
		for (const timer of this.timers.splice(0)) clearInterval(timer);
		for (const source of this.sourceAdapters) if (source.stop) await source.stop();
		await this.socket?.stop();
		this.socket = undefined;
		this.started = false;
		this.stopping = false;
	}
	private async refreshUsage(): Promise<void> {
		try {
			await this.providerScheduler.usage.refresh();
		} catch {
			/* unavailable profiles remain unavailable */
		}
	}
	private async pollSources(sourceName?: BackgroundSource): Promise<void> {
		for (const source of this.sourceAdapters)
			if ((!sourceName || source.source === sourceName) && source.poll) {
				try {
					await source.poll();
				} catch {
					/* retain the cursor and retry on the next interval */
				}
			}
	}
	private async schedulerTick(): Promise<void> {
		if (!this.options.attemptRunner || this.providerScheduler.emergencyStop) return;
		const candidates = this.database.all<{ id: string; role: string; state: string; rollout_mode: RolloutMode }>(
			"SELECT j.id, j.role, c.state, c.rollout_mode FROM jobs j JOIN cases c ON c.id = j.case_id WHERE j.state = 'queued' ORDER BY j.priority DESC, j.created_at ASC, j.id ASC",
		);
		let claim: JobClaim | null = null;
		for (const candidate of candidates) {
			if (!this.dispatchAllowed(candidate.role, candidate.state, candidate.rollout_mode)) continue;
			claim = this.providerScheduler.claim(candidate.id, this.owner);
			if (claim) break;
		}
		if (!claim) return;
		try {
			const result = await this.options.attemptRunner.run(claim, this.database);
			this.jobs.finishAttempt(
				{ attemptId: claim.attemptId, state: result.state, failure: result.failure },
				this.owner,
			);
		} catch (error) {
			this.jobs.finishAttempt(
				{
					attemptId: claim.attemptId,
					state: "failed",
					failure: error instanceof Error ? error.message : String(error),
				},
				this.owner,
			);
		}
	}
	private dispatchAllowed(role: string, state: string, rollout: RolloutMode): boolean {
		if (rollout === "observe" && role !== "investigator") return false;
		return role !== "worker" || state === "implementation";
	}
	private heartbeatTick(): void {
		for (const attempt of this.database.all<{ id: string }>(
			"SELECT a.id FROM attempts a JOIN attempt_leases l ON l.attempt_id = a.id WHERE a.state = 'running' AND l.owner = ?",
			this.owner,
		))
			this.jobs.renewLease(attempt.id, this.owner);
	}
	private async recoveryTick(): Promise<void> {
		for (const attempt of this.database.all<{ id: string }>("SELECT id FROM attempts WHERE state = 'running'")) {
			try {
				await this.recovery.reconcileAttempt(attempt.id);
			} catch {
				/* retry on next pass */
			}
		}
	}
	private async ciTick(): Promise<void> {
		if (this.options.ciReconcile) await this.options.ciReconcile();
	}
	private async backupTick(): Promise<void> {
		try {
			await createSqliteBackup({
				databasePath: this.config.databasePath,
				directory: this.config.backup.directory,
				retention: this.config.backup.retention,
				syncCommand: this.config.backup.syncCommand,
			});
		} catch {
			/* retry on next pass */
		}
	}
	snapshot(): DashboardSnapshot {
		const cases = this.database
			.all<Record<string, unknown>>(
				"SELECT id, title, source, state, repository, priority, rollout_mode, created_at, updated_at FROM cases ORDER BY updated_at DESC, id DESC",
			)
			.map((row) => ({
				id: String(row.id),
				title: String(row.title),
				source: row.source as BackgroundSource,
				state: row.state as DashboardSnapshot["cases"][number]["state"],
				...(row.repository == null ? {} : { repository: String(row.repository) }),
				...(row.priority == null ? {} : { priority: Number(row.priority) }),
				rollout: row.rollout_mode as RolloutMode,
				createdAt: String(row.created_at),
				updatedAt: String(row.updated_at),
			}));
		const attempts = this.database
			.all<Record<string, unknown>>(
				"SELECT id, case_id, role, generation, state, profile_id, model, systemd_unit, pane_id, worktree, branch, heartbeat_at, started_at, finished_at, failure FROM attempts ORDER BY created_at DESC",
			)
			.map((row) => ({
				id: String(row.id),
				caseId: String(row.case_id),
				role: row.role as AgentRole,
				generation: Number(row.generation),
				state: row.state as AttemptState,
				...(row.profile_id == null ? {} : { profileId: String(row.profile_id) }),
				...(row.model == null ? {} : { model: String(row.model) }),
				...(row.systemd_unit == null ? {} : { systemdUnit: String(row.systemd_unit) }),
				...(row.pane_id == null ? {} : { paneId: String(row.pane_id) }),
				...(row.worktree == null ? {} : { worktree: String(row.worktree) }),
				...(row.branch == null ? {} : { branch: String(row.branch) }),
				...(row.heartbeat_at == null ? {} : { heartbeatAt: String(row.heartbeat_at) }),
				...(row.started_at == null ? {} : { startedAt: String(row.started_at) }),
				...(row.finished_at == null ? {} : { finishedAt: String(row.finished_at) }),
				...(row.failure == null ? {} : { failure: String(row.failure) }),
			}));
		return {
			cases,
			attempts,
			profiles: this.config.profiles,
			rollout: this.runtimeRollout.defaultMode,
			emergencyStop: this.providerScheduler.emergencyStop,
			generatedAt: (this.options.clock ?? (() => new Date()))().toISOString(),
		};
	}
	async handle(request: BackgroundRequest): Promise<BackgroundResponse> {
		const validation = validateBackgroundRequest(request);
		if (validation)
			return { version: 1, id: request.id, ok: false, error: { code: "INVALID_REQUEST", message: validation } };
		try {
			let result: unknown;
			switch (request.type) {
				case "dashboard.get":
					result = this.snapshot();
					break;
				case "case.submit": {
					if (!this.config.sources.manual.enabled) throw new Error("manual source is disabled");
					const submitted = this.manual.submit(request as ManualSubmission);
					result = { accepted: true, caseId: submitted.caseId };
					break;
				}
				case "case.action":
					result = this.caseAction(request.caseId, request.action, request.comment);
					break;
				case "spec.feedback": {
					const latest = this.database.getLatestSpecification(request.caseId);
					if (!latest) throw new Error("case has no specification");
					result = this.specifications.recordHumanFeedback(
						request.caseId,
						latest.version,
						request.feedback,
						this.operator,
					);
					break;
				}
				case "spec.approve":
					result = this.specifications.approve(
						request.caseId,
						request.specVersion,
						request.permissions,
						this.operator,
					);
					break;
				case "classifier.correct":
					result = recordOperatorFeedback(this.database, {
						caseId: request.caseId,
						action: "reclassify",
						actor: this.operator,
						inputKind: request.classification.inputKind,
						disposition: request.classification.disposition,
						rationale: request.classification.rationale,
					});
					break;
				case "rollout.set":
					result = this.setRollout(request.scope, request.value, request.source, request.repository);
					break;
				case "emergency.stop":
					this.providerScheduler.setEmergencyStop(request.enabled);
					if (request.enabled)
						for (const row of this.database.all<{ case_id: string }>(
							"SELECT DISTINCT case_id FROM jobs WHERE state IN ('queued', 'running')",
						))
							this.jobs.pauseCaseJobs(row.case_id);
					result = { accepted: true };
					break;
				case "pane.focus":
					if (this.options.paneFocus) await this.options.paneFocus(request.paneId);
					result = { accepted: true };
					break;
				case "evidence.reproduce": {
					const manifestId = this.database.createEvidenceManifest({
						caseId: request.caseId,
						manifest: request.manifest,
					});
					const repository = this.database.get<{ repository: string }>(
						"SELECT repository FROM cases WHERE id = ?",
						request.caseId,
					)?.repository;
					if (!repository) throw new Error("case has no repository for evidence reproduction");
					result = await reproduceEvidenceOperation(
						{ operation: "evidence.reproduce", caseId: request.caseId, manifestId },
						{ database: this.database, repository, requiredChecks: this.config.ci.requiredChecks },
					);
					break;
				}
			}
			return { version: 1, id: request.id, ok: true, result };
		} catch (error) {
			return {
				version: 1,
				id: request.id,
				ok: false,
				error: { code: "REQUEST_FAILED", message: error instanceof Error ? error.message : String(error) },
			};
		}
	}
	private caseAction(caseId: string, action: CaseAction, comment?: string): unknown {
		switch (action) {
			case "resume":
				return this.stateMachine.resumeCase(caseId, this.operator, comment);
			case "cancel":
				this.stateMachine.cancelCase(caseId, this.operator, comment);
				this.jobs.cancelCaseJobs(caseId);
				return { accepted: true };
			case "mark-handled":
				this.stateMachine.transitionCase(caseId, "handled", this.operator, comment ?? "marked handled");
				return { accepted: true };
			case "reject": {
				const latest = this.database.getLatestSpecification(caseId);
				if (!latest) throw new Error("case has no specification");
				return this.stateMachine.rejectSpecification(caseId, latest.version, this.operator);
			}
			case "approve-specification": {
				const latest = this.database.getLatestSpecification(caseId);
				if (!latest) throw new Error("case has no specification");
				return this.specifications.approve(caseId, latest.version, [], this.operator);
			}
			case "request-changes": {
				const latest = this.database.getLatestSpecification(caseId);
				if (!latest) throw new Error("case has no specification");
				return this.specifications.recordHumanFeedback(
					caseId,
					latest.version,
					comment ?? "changes requested",
					this.operator,
				);
			}
			case "reclassify":
				return recordOperatorFeedback(this.database, {
					caseId,
					action: "reclassify",
					actor: this.operator,
					rationale: comment,
				});
		}
	}
	private setRollout(
		scope: "global" | "source" | "repository",
		value: RolloutMode,
		source?: BackgroundSource,
		repository?: string,
	): { accepted: true } {
		if (scope === "global") this.runtimeRollout.defaultMode = value;
		else if (scope === "source" && source) this.runtimeRollout.sourceOverrides[source] = value;
		else if (scope === "repository" && repository) this.runtimeRollout.repositoryOverrides[repository] = value;
		else throw new Error("rollout scope requires a target");
		const now = new Date().toISOString();
		if (scope === "repository" && repository)
			this.database.run(
				"UPDATE cases SET rollout_mode = ?, updated_at = ? WHERE repository = ?",
				value,
				now,
				repository,
			);
		if (scope === "source" && source)
			this.database.run("UPDATE cases SET rollout_mode = ?, updated_at = ? WHERE source = ?", value, now, source);
		if (scope === "global") this.database.run("UPDATE cases SET rollout_mode = ?, updated_at = ?", value, now);
		return { accepted: true };
	}
}
export function createBackgroundAgentsController(
	options: BackgroundControllerOptions = {},
): BackgroundAgentsController {
	return new BackgroundAgentsController(options);
}
