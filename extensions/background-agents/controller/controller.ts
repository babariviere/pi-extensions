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
import {
	LinearEffects,
	type LinearEffectClient,
	type LinearIssueSnapshot,
	type LinearWorkflowState,
} from "./effects/linear.ts";
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
import { QuickFixWorkflow } from "./workflows/investigation.ts";
import { SpecificationWorkflow } from "./workflows/specification.ts";
import { reproduceEvidenceOperation } from "./verification/reproduce.ts";
import { BackgroundSocketServer } from "./socket-server.ts";
import { inspectTransientService, stopTransientService } from "./runtime/systemd.ts";
import { herdr as defaultHerdr } from "../../spindle/agents/herdr-client.ts";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DASHBOARD_LIMIT = 100;
const DASHBOARD_TEXT_LIMIT = 400;
const SECRET_KEY =
	/(?:token|secret|password|credential|authorization|auth|api[_-]?key|reasoning|prompt|payload|body|transcript|path|directory|raw)/i;
function dashboardText(value: unknown, limit = DASHBOARD_TEXT_LIMIT): string {
	const text = String(value ?? "")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.trim();
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
function dashboardJson(value: unknown, depth = 0): unknown {
	if (depth > 2 || value === null || typeof value !== "object")
		return typeof value === "string" ? dashboardText(value, 160) : value;
	if (Array.isArray(value)) return value.slice(0, 20).map((item) => dashboardJson(item, depth + 1));
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
		if (SECRET_KEY.test(key)) continue;
		result[dashboardText(key, 80)] = dashboardJson(item, depth + 1);
	}
	return result;
}
function dashboardJsonText(value: unknown): string {
	try {
		return dashboardText(JSON.stringify(dashboardJson(value)) ?? "");
	} catch {
		return "-";
	}
}
function parseDashboardJson(row: Record<string, unknown>, field: string, fallback: unknown): unknown {
	if (typeof row[field] !== "string") return fallback;
	try {
		return JSON.parse(row[field] as string);
	} catch {
		return fallback;
	}
}
function dashboardList(value: unknown): string[] {
	if (!Array.isArray(value)) return value === undefined || value === null ? [] : [dashboardJsonText(value)];
	return value
		.slice(0, 20)
		.map((item) => dashboardText(typeof item === "string" ? item : dashboardJsonText(item), 240));
}
function dashboardDecomposition(value: unknown): DashboardSnapshot["specifications"][number]["decomposition"] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 20).flatMap((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const record = item as Record<string, unknown>;
		return [
			{
				order: Number(record.order),
				title: dashboardText(record.title),
				scope: dashboardText(record.scope),
				acceptanceCriteria: dashboardList(record.acceptanceCriteria),
			},
		];
	});
}
function dashboardRows<T>(rows: T[]): T[] {
	return rows.slice(0, DASHBOARD_LIMIT);
}
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
export class LinearHttpClient implements LinearGraphqlClient, LinearEffectClient {
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
	async getIssue(issueId: string): Promise<LinearIssueSnapshot | null> {
		const result = await this.query<{ data?: { issue?: Record<string, unknown> }; issue?: Record<string, unknown> }>(
			`query BackgroundAgentsIssue($id: String!) {
  issue(id: $id) { id updatedAt state { id name type } team { id key } }
}`,
			{ id: issueId },
		);
		const issue = result.data?.issue ?? result.issue;
		if (!issue) return null;
		const state = issue.state as { id?: string; name?: string; type?: string } | undefined;
		if (
			typeof issue.id !== "string" ||
			typeof issue.updatedAt !== "string" ||
			!state?.id ||
			!state.name ||
			!state.type
		)
			return null;
		const team = issue.team as { id?: string; key?: string } | undefined;
		return {
			id: issue.id,
			revision: issue.updatedAt,
			...(team?.id ? { teamId: team.id } : {}),
			...(team?.key ? { teamKey: team.key } : {}),
			state: { id: state.id, name: state.name, type: state.type },
		};
	}
	async getStartedStates(team: { id?: string; key?: string }): Promise<LinearWorkflowState[]> {
		const result = await this.query<{
			data?: { workflowStates?: { nodes?: LinearWorkflowState[] } };
			workflowStates?: { nodes?: LinearWorkflowState[] };
		}>(
			`query BackgroundAgentsStartedStates($teamId: ID!) {
  workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } }
}`,
			{ teamId: team.id },
		);
		return result.data?.workflowStates?.nodes ?? result.workflowStates?.nodes ?? [];
	}
	async updateIssueState(issueId: string, stateId: string): Promise<boolean> {
		const result = await this.query<{
			data?: { issueUpdate?: { success?: boolean } };
			issueUpdate?: { success?: boolean };
		}>(
			`mutation BackgroundAgentsStartIssue($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}`,
			{ id: issueId, stateId },
		);
		return (result.data?.issueUpdate ?? result.issueUpdate)?.success === true;
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

export interface BackgroundRuntimeControls {
	terminateSystemdUnit(unit: string): Promise<void>;
	isSystemdUnitStopped(unit: string): Promise<boolean>;
	closeTab?(tabId: string): Promise<void>;
	isTabClosed?(tabId: string): Promise<boolean>;
	closePane?(paneId: string): Promise<void>;
	isPaneStopped?(paneId: string): Promise<boolean>;
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
	runtimeControls?: BackgroundRuntimeControls;
	recovery?: Pick<RecoveryCoordinator, "reconcileAttempt">;
	linearEffects?: Pick<LinearEffects, "startWork">;
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

function linearIssueFromEvent(event: SourceEvent): LinearIssueSnapshot | undefined {
	if (event.source !== "linear" || !event.sourceKey.startsWith("linear:")) return undefined;
	const state = event.metadata?.state;
	if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
	const value = state as Record<string, unknown>;
	if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.type !== "string")
		return undefined;
	const team = event.metadata?.team;
	const teamValue = team && typeof team === "object" && !Array.isArray(team) ? (team as Record<string, unknown>) : {};
	return {
		id: event.sourceKey.slice("linear:".length),
		revision: event.revision ?? "",
		...(typeof teamValue.id === "string" ? { teamId: teamValue.id } : {}),
		...(typeof teamValue.key === "string" ? { teamKey: teamValue.key } : {}),
		state: { id: value.id, name: value.name, type: value.type },
	};
}

function candidateStateIsQuestion(database: BackgroundAgentsDatabase, jobId: string): boolean {
	return (
		database.get<{ state: string }>(
			"SELECT c.state FROM cases c JOIN jobs j ON j.case_id = c.id WHERE j.id = ?",
			jobId,
		)?.state === "question-analysis"
	);
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
	private readonly recovery: Pick<RecoveryCoordinator, "reconcileAttempt">;
	private readonly stateMachine: BackgroundAgentsStateMachine;
	private readonly questions: QuestionWorkflow;
	private readonly quickFixes: QuickFixWorkflow;
	private readonly specifications: SpecificationWorkflow;
	private readonly options: BackgroundControllerOptions;
	private readonly timers: ReturnType<typeof setInterval>[] = [];
	private readonly runtimeRollout: BackgroundAgentsConfig["rollout"];
	private readonly runtimeControls: BackgroundRuntimeControls;
	private readonly linearEffects?: Pick<LinearEffects, "startWork">;
	private socket?: BackgroundSocketServer;
	private started = false;
	private stopping = false;
	constructor(options: BackgroundControllerOptions = {}) {
		this.options = options;
		this.config = options.config ?? normalizeBackgroundAgentsConfig({});
		validateBackgroundAgentsConfig(this.config, { checkPaths: true, credentialStat: options.credentialStat });
		this.database = options.database ?? new BackgroundAgentsDatabase(this.config.databasePath);
		this.database.initializeControlState(this.config.rollout);
		const durableControls = this.database.getControlState();
		this.owner = options.owner?.trim() || `background-controller-${process.pid}`;
		this.operator = options.operator?.trim() || "socket-owner";
		this.runtimeRollout = {
			defaultMode: durableControls.rollout.defaultMode,
			sourceOverrides: { ...durableControls.rollout.sourceOverrides },
			repositoryOverrides: { ...durableControls.rollout.repositoryOverrides },
		};
		this.runtimeControls = options.runtimeControls ?? {
			terminateSystemdUnit: (unit) => stopTransientService(unit),
			isSystemdUnitStopped: async (unit) => ["inactive", "failed"].includes(await inspectTransientService(unit)),
			closeTab: (tabId) => defaultHerdr.closeTab(tabId),
			isTabClosed: (tabId) => defaultHerdr.isTabClosed(tabId),
		};
		const linearConfig = this.config.sources.linear;
		this.linearEffects =
			options.linearEffects ??
			(linearConfig.enabled && linearConfig.credentialPath
				? new LinearEffects(
						this.database,
						new LinearHttpClient(linearConfig.url, linearConfig.credentialPath, this.options.fetcher ?? fetch),
						{ owner: `background:${this.owner}` },
					)
				: undefined);
		const store: SourceStore = {
			recordSourceEvent: (event, sourceOptions) => {
				const result = this.database.recordSourceEvent(event, {
					...sourceOptions,
					rolloutMode: sourceOptions?.rolloutMode ?? this.rolloutFor(event.source, event.repository),
				});
				this.database.reconcileClassifierJob(result.caseId);
				return result;
			},
			recordSourceEventAndAdvanceCursor: (event, cursor, sourceOptions) => {
				const result = this.database.recordSourceEventAndAdvanceCursor(event, cursor, {
					...sourceOptions,
					rolloutMode: sourceOptions?.rolloutMode ?? this.rolloutFor(event.source, event.repository),
				});
				this.database.reconcileClassifierJob(result.caseId);
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
		this.jobs = new JobScheduler(this.database, { emergencyStop: durableControls.emergencyStop });
		this.providerScheduler = new ProviderScheduler(this.database, this.config, {
			emergencyStop: durableControls.emergencyStop,
			usageOptions: {
				credentialStat: options.credentialStat,
				credentialOwnerUid: this.config.socket.ownerUid ?? process.getuid?.(),
				reconcileAttempt: (attempt, reason, now) => this.reconcileUsageAttempt(attempt, reason, now),
			},
		});
		this.recovery = options.recovery ?? new RecoveryCoordinator(this.database, { owner: this.owner });
		this.stateMachine = new BackgroundAgentsStateMachine(this.database);
		this.questions = new QuestionWorkflow(this.database);
		this.quickFixes = new QuickFixWorkflow(this.database);
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
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.stopping = false;
		this.database.reconcileClassifierJobs();
		if (this.options.startSocket !== false) {
			this.socket = new BackgroundSocketServer({ ...this.config.socket, handle: (request) => this.handle(request) });
			await this.socket.start();
		}
		if (this.providerScheduler.emergencyStop) {
			try {
				await this.reconcileEmergencyStopAttempts();
			} catch {
				// Keep the durable stop active and retry on the next recovery tick.
			}
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
		await this.reconcileUsageStopIntents();
	}
	private async reconcileUsageStopIntents(): Promise<void> {
		for (const intent of this.database.listPendingUsageStopIntents()) {
			const attempt = this.database.get<{ case_id: string; role: AgentRole }>(
				"SELECT case_id, role FROM attempts WHERE id = ?",
				intent.attemptId,
			);
			if (!attempt) {
				this.database.markUsageStopIntent(intent.attemptId, { systemdConfirmed: true, paneConfirmed: true });
				continue;
			}
			try {
				await this.reconcileUsageAttempt(
					{
						attemptId: intent.attemptId,
						jobId: intent.jobId,
						caseId: attempt.case_id,
						role: attempt.role,
						...(intent.systemdUnit ? { systemdUnit: intent.systemdUnit } : {}),
						...(intent.tabId ? { tabId: intent.tabId } : {}),
						...(intent.paneId ? { paneId: intent.paneId } : {}),
					},
					intent.reason,
					this.options.clock?.() ?? new Date(),
				);
			} catch {
				// Keep the intent pending so the next usage or recovery tick retries it.
			}
		}
	}
	private async reconcileUsageAttempt(
		attempt: {
			attemptId: string;
			jobId: string;
			caseId: string;
			role: AgentRole;
			systemdUnit?: string;
			tabId?: string;
			paneId?: string;
			worktree?: string;
		},
		reason: string,
		now: Date,
	): Promise<void> {
		const failures: string[] = [];
		const intent = this.database.listPendingUsageStopIntents().find((item) => item.attemptId === attempt.attemptId);
		if (attempt.systemdUnit)
			try {
				if (!intent?.systemdConfirmed) {
					await this.runtimeControls.terminateSystemdUnit(attempt.systemdUnit);
					if (!(await this.runtimeControls.isSystemdUnitStopped(attempt.systemdUnit)))
						failures.push(`systemd unit remains active: ${attempt.systemdUnit}`);
					else this.database.markUsageStopIntent(attempt.attemptId, { systemdConfirmed: true });
				}
			} catch (error) {
				failures.push(`systemd stop: ${error instanceof Error ? error.message : String(error)}`);
			}
		if (attempt.tabId && !intent?.tabConfirmed) {
			if (this.runtimeControls.closeTab) {
				try {
					await this.runtimeControls.closeTab(attempt.tabId);
					if (!this.runtimeControls.isTabClosed) throw new Error("tab closure cannot be confirmed");
					const closed = await this.runtimeControls.isTabClosed(attempt.tabId);
					if (!closed) failures.push(`tab remains active: ${attempt.tabId}`);
					else this.database.markUsageStopIntent(attempt.attemptId, { tabConfirmed: true });
				} catch (error) {
					failures.push(`tab close: ${error instanceof Error ? error.message : String(error)}`);
				}
			} else failures.push(`tab close is unavailable: ${attempt.tabId}`);
		} else if (!attempt.tabId && attempt.paneId && !intent?.paneConfirmed) {
			if (this.runtimeControls.closePane) {
				try {
					await this.runtimeControls.closePane(attempt.paneId);
					const stopped = this.runtimeControls.isPaneStopped
						? await this.runtimeControls.isPaneStopped(attempt.paneId)
						: true;
					if (!stopped) failures.push(`pane remains active: ${attempt.paneId}`);
					else this.database.markUsageStopIntent(attempt.attemptId, { paneConfirmed: true });
				} catch (error) {
					failures.push(`pane close: ${error instanceof Error ? error.message : String(error)}`);
				}
			} else this.database.markUsageStopIntent(attempt.attemptId, { paneConfirmed: true });
		}
		const state = this.database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", attempt.caseId)?.state;
		if (state !== "paused-usage") {
			try {
				this.stateMachine.pauseCase(attempt.caseId, this.operator, reason, true);
			} catch (error) {
				failures.push(`case pause: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		this.database.recordOperatorEvent(
			"usage-attempt-reconciled",
			this.operator,
			{
				attemptId: attempt.attemptId,
				jobId: attempt.jobId,
				caseId: attempt.caseId,
				role: attempt.role,
				reason,
				worktree: attempt.worktree,
				failures,
			},
			now,
		);
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
		this.database.reconcileClassifierRetries(
			this.config.classifier.maxAttempts,
			this.config.classifier.retryBackoffMs,
			this.options.clock?.() ?? new Date(),
		);
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
		const claimedRole = this.database.get<{ role: AgentRole }>(
			"SELECT role FROM jobs WHERE id = ?",
			claim.jobId,
		)?.role;
		const phase = claimedRole === "investigator" ? "investigation" : "specification";
		const finish = async (result: AttemptRunnerResult): Promise<void> => {
			const role = this.database.get<{ role: AgentRole }>("SELECT role FROM jobs WHERE id = ?", claim.jobId)?.role;
			if (result.state === "failed" && role === "worker") {
				try {
					const recovery = await this.recovery.reconcileAttempt(claim.attemptId);
					if (recovery.action === "running" || recovery.action === "replaced" || recovery.action === "needs-human")
						return;
				} catch (error) {
					const failure = error instanceof Error ? error.message : String(error);
					this.database.markAttemptNeedsHuman(claim.attemptId, `worker failure recovery failed: ${failure}`);
					return;
				}
			}
			this.jobs.finishAttempt(
				{ attemptId: claim.attemptId, state: result.state, failure: result.failure, now: this.options.clock?.() },
				this.owner,
			);
		};
		try {
			if (this.linearEffects && (claimedRole === "investigator" || claimedRole === "spec-planner")) {
				const caseRow = this.database.get<{ case_id: string }>(
					"SELECT case_id FROM jobs WHERE id = ?",
					claim.jobId,
				);
				const eventRow = caseRow
					? this.database.get<{ id: string }>(
							"SELECT id FROM source_events WHERE case_id = ? ORDER BY received_at DESC, created_at DESC LIMIT 1",
							caseRow.case_id,
						)
					: undefined;
				const event = eventRow ? this.database.getSourceEvent(eventRow.id) : undefined;
				const issue = event ? linearIssueFromEvent(event) : undefined;
				const repository = caseRow
					? this.database.get<{ repository: string | null }>(
							"SELECT repository FROM cases WHERE id = ?",
							caseRow.case_id,
						)?.repository
					: undefined;
				if (
					issue &&
					repository &&
					!(claimedRole === "investigator" && candidateStateIsQuestion(this.database, claim.jobId))
				)
					await this.linearEffects.startWork({
						issue,
						phase,
						owner: this.owner,
						stopEpoch: claim.stopEpoch,
						isAuthorized: () => this.database.attemptMayPublish(claim.attemptId, claim.stopEpoch),
					});
				this.database.assertAttemptMayPublish(claim.attemptId, claim.stopEpoch);
			}
			const result = await this.options.attemptRunner.run(claim, this.database);
			await finish(result);
		} catch (error) {
			await finish({
				state: "failed",
				failure: error instanceof Error ? error.message : String(error),
			});
		}
	}
	private dispatchAllowed(role: string, state: string, rollout: RolloutMode): boolean {
		if (rollout === "observe" && role !== "classifier" && role !== "investigator") return false;
		return role !== "worker" || ["implementation", "verification", "pull-request-review"].includes(state);
	}
	private async setEmergencyStop(enabled: boolean): Promise<{ accepted: true }> {
		if (!enabled) {
			const failures = await this.reconcileEmergencyStopAttempts();
			if (failures.length > 0) throw new Error(`Emergency stop remains enabled: ${failures.join("; ")}`);
			if (
				this.database
					.listEmergencyStopAttempts()
					.some((attempt) => !attempt.systemdConfirmed || !attempt.tabConfirmed || !attempt.reconciled)
			)
				throw new Error("Emergency stop attempts are not fully reconciled");
			this.database.resumeEmergencyStopJobs(this.options.clock?.() ?? new Date());
			this.providerScheduler.setEmergencyStop(false, this.operator);
			return { accepted: true };
		}
		this.providerScheduler.setEmergencyStop(true, this.operator);
		const failures = await this.reconcileEmergencyStopAttempts();
		const pausedJobIds = this.database
			.all<{ id: string }>("SELECT id FROM jobs WHERE state IN ('queued', 'running') ORDER BY id")
			.map((job) => job.id);
		try {
			this.database.pauseEmergencyStopJobs(pausedJobIds, this.options.clock?.() ?? new Date());
		} catch (error) {
			failures.push(`emergency-stop pause: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.database.recordOperatorEvent("emergency-stop.reconciled", this.operator, {
			attemptIds: this.database.listEmergencyStopAttempts().map((attempt) => attempt.attemptId),
			pausedJobIds,
			failures,
		});
		if (failures.length > 0) throw new Error(`Emergency stop completed with failures: ${failures.join("; ")}`);
		return { accepted: true };
	}
	private async reconcileEmergencyStopAttempts(): Promise<string[]> {
		const failures: string[] = [];
		for (const stopAttempt of this.database.listEmergencyStopAttempts()) {
			const attempt = this.database.get<{
				id: string;
				systemd_unit: string | null;
				tab_id: string | null;
				pane_id: string | null;
				state: string;
			}>("SELECT id, systemd_unit, tab_id, pane_id, state FROM attempts WHERE id = ?", stopAttempt.attemptId);
			if (!attempt) {
				this.database.markEmergencyStopAttempt(stopAttempt.attemptId, {
					systemdConfirmed: true,
					tabConfirmed: true,
					reconciled: true,
				});
				continue;
			}
			let systemdConfirmed = stopAttempt.systemdConfirmed;
			if (attempt.systemd_unit && !stopAttempt.systemdConfirmed) {
				try {
					if (!["inactive", "failed"].includes(attempt.state))
						await this.runtimeControls.terminateSystemdUnit(attempt.systemd_unit);
					if (!(await this.runtimeControls.isSystemdUnitStopped(attempt.systemd_unit)))
						throw new Error(`systemd unit did not terminate: ${attempt.systemd_unit}`);
					systemdConfirmed = true;
					this.database.markEmergencyStopAttempt(attempt.id, { systemdConfirmed: true });
				} catch (error) {
					failures.push(
						`attempt ${attempt.id} systemd: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			} else if (!attempt.systemd_unit) {
				systemdConfirmed = true;
				this.database.markEmergencyStopAttempt(attempt.id, { systemdConfirmed: true });
			}
			let runtimeConfirmed = attempt.tab_id ? stopAttempt.tabConfirmed : !attempt.pane_id;
			if (attempt.tab_id && !runtimeConfirmed) {
				if (this.runtimeControls.closeTab) {
					try {
						await this.runtimeControls.closeTab(attempt.tab_id);
						if (!this.runtimeControls.isTabClosed) throw new Error("tab closure cannot be confirmed");
						runtimeConfirmed = await this.runtimeControls.isTabClosed(attempt.tab_id);
						if (!runtimeConfirmed) failures.push(`attempt ${attempt.id} tab remains active: ${attempt.tab_id}`);
						else this.database.markEmergencyStopAttempt(attempt.id, { tabConfirmed: true });
					} catch (error) {
						failures.push(`attempt ${attempt.id} tab: ${error instanceof Error ? error.message : String(error)}`);
					}
				} else failures.push(`attempt ${attempt.id} tab close is unavailable: ${attempt.tab_id}`);
			} else if (!attempt.tab_id && attempt.pane_id && !runtimeConfirmed) {
				if (this.runtimeControls.closePane) {
					try {
						await this.runtimeControls.closePane(attempt.pane_id);
						runtimeConfirmed = this.runtimeControls.isPaneStopped
							? await this.runtimeControls.isPaneStopped(attempt.pane_id)
							: true;
						if (!runtimeConfirmed) failures.push(`attempt ${attempt.id} pane remains active: ${attempt.pane_id}`);
						else this.database.markEmergencyStopAttempt(attempt.id, { tabConfirmed: true });
					} catch (error) {
						failures.push(
							`attempt ${attempt.id} pane: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				} else failures.push(`attempt ${attempt.id} pane close is unavailable: ${attempt.pane_id}`);
			} else if (!attempt.tab_id && !attempt.pane_id) {
				runtimeConfirmed = true;
				this.database.markEmergencyStopAttempt(attempt.id, { tabConfirmed: true });
			}
			try {
				const result = await this.recovery.reconcileAttempt(attempt.id);
				if (result.action === "running") throw new Error("attempt remains active");
				if (systemdConfirmed && runtimeConfirmed)
					this.database.markEmergencyStopAttempt(attempt.id, { reconciled: true });
			} catch (error) {
				failures.push(`attempt ${attempt.id} reconcile: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return failures;
	}
	private heartbeatTick(): void {
		for (const attempt of this.database.all<{ id: string }>(
			"SELECT a.id FROM attempts a JOIN attempt_leases l ON l.attempt_id = a.id WHERE a.state = 'running' AND l.owner = ?",
			this.owner,
		))
			this.jobs.renewLease(attempt.id, this.owner);
	}
	private async recoveryTick(): Promise<void> {
		await this.reconcileUsageStopIntents();
		if (this.providerScheduler.emergencyStop) await this.reconcileEmergencyStopAttempts();
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
		const cases = dashboardRows(
			this.database
				.all<Record<string, unknown>>(
					"SELECT id, title, source, state, repository, priority, rollout_mode, created_at, updated_at FROM cases ORDER BY updated_at DESC, id DESC",
				)
				.map((row) => ({
					id: dashboardText(row.id, 120),
					title: dashboardText(row.title),
					source: row.source as BackgroundSource,
					state: row.state as DashboardSnapshot["cases"][number]["state"],
					...(row.repository == null ? {} : { repository: dashboardText(row.repository, 240) }),
					...(row.priority == null ? {} : { priority: Number(row.priority) }),
					rollout: row.rollout_mode as RolloutMode,
					createdAt: dashboardText(row.created_at, 40),
					updatedAt: dashboardText(row.updated_at, 40),
				})),
		);
		const attempts = dashboardRows(
			this.database
				.all<Record<string, unknown>>(
					"SELECT id, case_id, role, generation, state, profile_id, model, systemd_unit, tab_id, pane_id, worktree, branch, heartbeat_at, started_at, finished_at, failure FROM attempts ORDER BY created_at DESC",
				)
				.map((row) => ({
					id: dashboardText(row.id, 120),
					caseId: dashboardText(row.case_id, 120),
					role: row.role as AgentRole,
					generation: Number(row.generation),
					state: row.state as AttemptState,
					...(row.profile_id == null ? {} : { profileId: dashboardText(row.profile_id, 120) }),
					...(row.model == null ? {} : { model: dashboardText(row.model, 160) }),
					...(row.systemd_unit == null ? {} : { systemdUnit: dashboardText(row.systemd_unit, 160) }),
					...(row.tab_id == null ? {} : { tabId: dashboardText(row.tab_id, 160) }),
					...(row.pane_id == null ? {} : { paneId: dashboardText(row.pane_id, 160) }),
					...(row.worktree == null ? {} : { worktree: dashboardText(row.worktree, 240) }),
					...(row.branch == null ? {} : { branch: dashboardText(row.branch, 240) }),
					...(row.heartbeat_at == null ? {} : { heartbeatAt: dashboardText(row.heartbeat_at, 40) }),
					...(row.started_at == null ? {} : { startedAt: dashboardText(row.started_at, 40) }),
					...(row.finished_at == null ? {} : { finishedAt: dashboardText(row.finished_at, 40) }),
					...(row.failure == null ? {} : { failure: dashboardText(row.failure) }),
				})),
		);
		const workItems = dashboardRows(
			this.database
				.all<Record<string, unknown>>(
					"SELECT id, case_id, ordinal, parent_id, title, scope, acceptance_criteria, branch, pull_request, state, created_at, updated_at FROM work_items ORDER BY case_id, ordinal",
				)
				.map((row) => ({
					id: dashboardText(row.id, 120),
					caseId: dashboardText(row.case_id, 120),
					ordinal: Number(row.ordinal),
					...(row.parent_id == null ? {} : { parentId: dashboardText(row.parent_id, 120) }),
					title: dashboardText(row.title),
					...(row.scope == null ? {} : { scope: dashboardText(row.scope) }),
					acceptanceCriteria: dashboardList(parseDashboardJson(row, "acceptance_criteria", [])),
					...(row.branch == null ? {} : { branch: dashboardText(row.branch, 240) }),
					...(row.pull_request == null ? {} : { pullRequest: Number(row.pull_request) }),
					state: dashboardText(row.state, 40),
					createdAt: dashboardText(row.created_at, 40),
					updatedAt: dashboardText(row.updated_at, 40),
				})),
		);
		const stacks = [...new Set(workItems.map((item) => item.caseId))].slice(0, DASHBOARD_LIMIT).map((caseId) => ({
			caseId,
			workItemIds: workItems
				.filter((item) => item.caseId === caseId)
				.map((item) => item.id)
				.slice(0, 20),
		}));
		const classificationRows = this.database.all<Record<string, unknown>>(
			"SELECT id, case_id, input_kind, disposition, actionability, noise, confidence, model_version, policy_version, created_at FROM classifications ORDER BY created_at DESC, id DESC",
		);
		const classifications = dashboardRows(
			classificationRows
				.filter((row, index, rows) => rows.findIndex((candidate) => candidate.case_id === row.case_id) === index)
				.map((row) => ({
					id: dashboardText(row.id, 120),
					caseId: dashboardText(row.case_id, 120),
					inputKind: row.input_kind as DashboardSnapshot["classifications"][number]["inputKind"],
					disposition: row.disposition as DashboardSnapshot["classifications"][number]["disposition"],
					actionability: Number(row.actionability),
					noise: Number(row.noise),
					confidence: Number(row.confidence),
					policyVersion: dashboardText(row.policy_version, 120),
					modelVersion: dashboardText(row.model_version, 160),
					createdAt: dashboardText(row.created_at, 40),
				})),
		);
		const policies = dashboardRows(
			this.database
				.all<Record<string, unknown>>(
					"SELECT id, scope, version, status, created_at, activated_at FROM classifier_policies ORDER BY created_at DESC, id DESC",
				)
				.map((row) => ({
					id: dashboardText(row.id, 120),
					scope: dashboardText(row.scope, 120),
					version: dashboardText(row.version, 120),
					status: row.status as DashboardSnapshot["policies"][number]["status"],
					createdAt: dashboardText(row.created_at, 40),
					...(row.activated_at == null ? {} : { activatedAt: dashboardText(row.activated_at, 40) }),
				})),
		);
		const memoryRows = this.database.all<Record<string, unknown>>(
			"SELECT id, case_id, finding, outcome, root_cause, evidence_summary, confidence, scope, supersedes_id, created_at, updated_at FROM memory_entries WHERE approval_status = 'approved' ORDER BY updated_at DESC, id DESC",
		);
		const memory = dashboardRows(
			memoryRows.map((row) => ({
				id: dashboardText(row.id, 120),
				...(row.case_id == null ? {} : { caseId: dashboardText(row.case_id, 120) }),
				finding: dashboardText(row.finding),
				...(row.outcome == null ? {} : { outcome: dashboardText(row.outcome) }),
				...(row.root_cause == null ? {} : { rootCause: dashboardText(row.root_cause) }),
				evidenceSummary: dashboardText(row.evidence_summary),
				confidence: Number(row.confidence),
				scope: dashboardText(row.scope, 160),
				approvalStatus: "approved" as const,
				...(row.supersedes_id == null ? {} : { supersedesId: dashboardText(row.supersedes_id, 120) }),
				provenance:
					row.case_id == null ? "operator-approved, case-independent" : `case ${dashboardText(row.case_id, 120)}`,
				supersededByIds: memoryRows
					.filter((candidate) => candidate.supersedes_id === row.id)
					.map((candidate) => dashboardText(candidate.id, 120))
					.slice(0, 20),
				createdAt: dashboardText(row.created_at, 40),
				updatedAt: dashboardText(row.updated_at, 40),
			})),
		);
		const specRows = this.database.all<Record<string, unknown>>(
			"SELECT id, case_id, version, specification, decisions, unresolved_questions, permissions, material_hash, planner_summary, decomposition, created_at FROM spec_versions ORDER BY created_at DESC, version DESC",
		);
		const specifications = dashboardRows(
			specRows.map((row) => ({
				id: dashboardText(row.id, 120),
				caseId: dashboardText(row.case_id, 120),
				version: Number(row.version),
				summary:
					row.planner_summary == null
						? dashboardJsonText(parseDashboardJson(row, "specification", {}))
						: dashboardText(row.planner_summary),
				decisions: dashboardList(parseDashboardJson(row, "decisions", [])),
				unresolvedQuestions: dashboardList(parseDashboardJson(row, "unresolved_questions", [])),
				permissions: dashboardList(parseDashboardJson(row, "permissions", [])),
				decomposition: dashboardDecomposition(parseDashboardJson(row, "decomposition", [])),
				materialHash: dashboardText(row.material_hash, 160),
				createdAt: dashboardText(row.created_at, 40),
			})),
		);
		const approvals = dashboardRows(
			this.database
				.all<Record<string, unknown>>(
					"SELECT id, spec_version_id, spec_version, decision, actor, permissions, ordered_work_items, created_at FROM approvals ORDER BY created_at DESC, id DESC",
				)
				.map((row) => ({
					id: dashboardText(row.id, 120),
					caseId: dashboardText(
						specRows.find((spec) => spec.id === row.spec_version_id)?.case_id ?? "unknown",
						120,
					),
					specVersion: Number(row.spec_version),
					decision: row.decision as DashboardSnapshot["approvals"][number]["decision"],
					actor: dashboardText(row.actor, 120),
					permissions: dashboardList(parseDashboardJson(row, "permissions", [])),
					orderedWorkItemIds: dashboardList(parseDashboardJson(row, "ordered_work_items", [])),
					createdAt: dashboardText(row.created_at, 40),
				})),
		);
		const quickFixProposals = dashboardRows(
			this.database
				.all<Record<string, unknown>>(
					"SELECT id, case_id, work_item_id, findings, scope, risks, verification_plan, decision, rollout_mode, decision_reason, decided_by, created_at, updated_at FROM quick_fix_proposals ORDER BY updated_at DESC, id DESC",
				)
				.map((row) => ({
					id: dashboardText(row.id, 120),
					caseId: dashboardText(row.case_id, 120),
					workItemId: dashboardText(row.work_item_id, 120),
					findings: dashboardText(row.findings),
					scope: dashboardText(row.scope),
					risks: dashboardList(parseDashboardJson(row, "risks", [])),
					verificationPlan: dashboardList(parseDashboardJson(row, "verification_plan", [])),
					rolloutMode: row.rollout_mode as NonNullable<
						DashboardSnapshot["quickFixProposals"]
					>[number]["rolloutMode"],
					decision: row.decision as NonNullable<DashboardSnapshot["quickFixProposals"]>[number]["decision"],
					decisionReason: dashboardText(row.decision_reason),
					...(row.decided_by == null ? {} : { decidedBy: dashboardText(row.decided_by, 120) }),
					createdAt: dashboardText(row.created_at, 40),
					updatedAt: dashboardText(row.updated_at, 40),
				})),
		);
		const workItemApprovals = dashboardRows(
			this.database
				.all<Record<string, unknown>>(
					"SELECT id, case_id, work_item_id, spec_version, decision, actor, created_at FROM work_item_approvals ORDER BY created_at DESC, id DESC",
				)
				.map((row) => ({
					id: dashboardText(row.id, 120),
					caseId: dashboardText(row.case_id, 120),
					workItemId: dashboardText(row.work_item_id, 120),
					specVersion: Number(row.spec_version),
					decision: row.decision as "approved" | "rejected",
					actor: dashboardText(row.actor, 120),
					createdAt: dashboardText(row.created_at, 40),
				})),
		);
		const feedback = dashboardRows(
			this.database
				.all<Record<string, unknown>>(
					"SELECT id, case_id, classification_id, correction, actor, created_at FROM feedback ORDER BY created_at DESC, id DESC",
				)
				.map((row) => ({
					id: dashboardText(row.id, 120),
					...(row.case_id == null ? {} : { caseId: dashboardText(row.case_id, 120) }),
					...(row.classification_id == null
						? {}
						: { classificationId: dashboardText(row.classification_id, 120) }),
					actor: dashboardText(row.actor, 120),
					correction: dashboardJsonText(parseDashboardJson(row, "correction", {})),
					createdAt: dashboardText(row.created_at, 40),
				})),
		);
		const questionBriefs = dashboardRows(
			this.database
				.all<Record<string, unknown>>(
					"SELECT id, case_id, attempt_id, question, findings, sources, confidence, uncertainties, limits, created_at FROM question_briefs ORDER BY created_at DESC, id DESC",
				)
				.map((row) => ({
					id: dashboardText(row.id, 120),
					caseId: dashboardText(row.case_id, 120),
					...(row.attempt_id == null ? {} : { attemptId: dashboardText(row.attempt_id, 120) }),
					question: dashboardText(row.question),
					findings: dashboardList(parseDashboardJson(row, "findings", [])),
					sources: dashboardList(parseDashboardJson(row, "sources", [])),
					confidence: Number(row.confidence),
					uncertainties: dashboardList(parseDashboardJson(row, "uncertainties", [])),
					limits: dashboardJsonText(parseDashboardJson(row, "limits", {})),
					createdAt: dashboardText(row.created_at, 40),
				})),
		);
		const artifacts = dashboardRows(
			this.database
				.all<Record<string, unknown>>(
					"SELECT id, case_id, attempt_id, kind, url, hash, transcript_reference, created_at FROM artifacts ORDER BY created_at DESC, id DESC",
				)
				.map((row) => ({
					id: dashboardText(row.id, 120),
					...(row.case_id == null ? {} : { caseId: dashboardText(row.case_id, 120) }),
					...(row.attempt_id == null ? {} : { attemptId: dashboardText(row.attempt_id, 120) }),
					kind: dashboardText(row.kind, 120),
					...(row.url == null ? {} : { url: dashboardText(row.url, 240) }),
					...(row.hash == null ? {} : { hash: dashboardText(row.hash, 160) }),
					...(row.transcript_reference == null
						? {}
						: { transcriptReference: dashboardText(row.transcript_reference, 160) }),
					createdAt: dashboardText(row.created_at, 40),
				})),
		);
		const jobs = dashboardRows(
			this.database
				.all<Record<string, unknown>>(
					"SELECT id, case_id, work_item_id, role, state, priority, claimed_by, claimed_at, created_at, updated_at FROM jobs ORDER BY updated_at DESC, id DESC",
				)
				.map((row) => ({
					id: dashboardText(row.id, 120),
					caseId: dashboardText(row.case_id, 120),
					...(row.work_item_id == null ? {} : { workItemId: dashboardText(row.work_item_id, 120) }),
					role: row.role as AgentRole,
					state: row.state as AttemptState,
					priority: Number(row.priority),
					...(row.claimed_by == null ? {} : { claimedBy: dashboardText(row.claimed_by, 120) }),
					...(row.claimed_at == null ? {} : { claimedAt: dashboardText(row.claimed_at, 40) }),
					createdAt: dashboardText(row.created_at, 40),
					updatedAt: dashboardText(row.updated_at, 40),
				})),
		);
		const profiles = this.config.profiles.map((profile) => ({
			id: dashboardText(profile.id, 120),
			provider: profile.provider,
			allowedModels: profile.allowedModels.slice(0, 20).map((model) => dashboardText(model, 160)),
			allowedRoles: profile.allowedRoles,
			maxBackgroundAttempts: profile.maxBackgroundAttempts,
			interactiveReserve: profile.interactiveReserve,
			usageStaleAfterMs: profile.usageStaleAfterMs,
		}));
		const usage = dashboardRows(
			profiles.map((profile) => {
				const state = this.database.get<Record<string, unknown>>(
					"SELECT available, active_attempts, concurrency_limit, interactive_reserve, cooldown_until FROM provider_profile_state WHERE profile_id = ?",
					profile.id,
				);
				return {
					profileId: profile.id,
					available: state ? Boolean(state.available) : true,
					activeAttempts: Number(
						state?.active_attempts ??
							attempts.filter((attempt) => attempt.profileId === profile.id && attempt.state === "running")
								.length,
					),
					concurrencyLimit: Number(state?.concurrency_limit ?? 1),
					interactiveReserve: Number(state?.interactive_reserve ?? profile.interactiveReserve),
					...(state?.cooldown_until == null ? {} : { cooldownUntil: dashboardText(state.cooldown_until, 40) }),
					windows: this.database
						.latestUsageSnapshots(profile.id)
						.slice(0, 10)
						.map((window) => ({
							quotaWindow: dashboardText(window.quotaWindow, 80),
							used: window.used,
							...(window.remaining === undefined ? {} : { remaining: window.remaining }),
							observedAt: dashboardText(window.observedAt, 40),
						})),
				};
			}),
		);
		const manifestRows = dashboardRows(
			this.database.all<Record<string, unknown>>(
				"SELECT id, case_id, version, base_sha, candidate_sha, created_at FROM evidence_manifests ORDER BY created_at DESC, version DESC",
			),
		);
		const evidenceManifests = manifestRows.map((row) => {
			const manifest = this.database.getEvidenceManifest(dashboardText(row.id, 120));
			return {
				id: dashboardText(row.id, 120),
				caseId: dashboardText(row.case_id, 120),
				version: Number(row.version),
				baseSha: dashboardText(row.base_sha, 160),
				candidateSha: dashboardText(row.candidate_sha, 160),
				commands: (manifest?.commands ?? []).slice(0, 20).map((command) => ({
					executable: dashboardText(command.executable, 160),
					argv: (command.argv ?? command.args ?? []).slice(0, 30).map((arg) => dashboardText(arg, 240)),
					cwd: dashboardText(command.cwd ?? command.workingDirectory, 240),
					phase: command.phase,
					purpose: command.purpose,
					expectedExitCode: command.expected?.exitCode ?? command.expectedExitCode ?? 0,
					...(command.actual?.exitCode === undefined ? {} : { actualExitCode: command.actual.exitCode }),
					...(command.actual?.outputHash === undefined
						? {}
						: { outputHash: dashboardText(command.actual.outputHash, 160) }),
					...(command.actual?.outputBytes === undefined ? {} : { outputBytes: command.actual.outputBytes }),
					...(command.actual?.outputTruncated === undefined
						? {}
						: { outputTruncated: command.actual.outputTruncated }),
				})),
				createdAt: dashboardText(row.created_at, 40),
				toolVersions: Object.fromEntries(
					Object.entries(manifest?.toolVersions ?? {})
						.slice(0, 20)
						.map(([key, value]) => [dashboardText(key, 80), dashboardText(value, 160)]),
				),
			};
		});
		const verificationRuns = dashboardRows(
			manifestRows.flatMap((manifest) =>
				this.database.listVerificationRuns(dashboardText(manifest.id, 120)).map((run) => ({
					id: dashboardText(run.id, 120),
					manifestId: dashboardText(run.manifestId, 120),
					verdict: run.verdict,
					confidence: run.confidence.score,
					ciChecks: Object.fromEntries(Object.entries(run.ciChecks).slice(0, 20)),
					rationale: dashboardText(run.rationale),
					uncertainties: run.uncertainties.slice(0, 20).map((item) => dashboardText(item, 240)),
					replayHistory: (run.replayHistory ?? []).slice(0, 20).map((item) => dashboardText(item, 120)),
					createdAt: dashboardText(run.createdAt, 40),
				})),
			),
		);
		const system = {
			started: this.started,
			activeAttempts: Number(
				this.database.get<{ count: number }>("SELECT count(*) AS count FROM attempts WHERE state = 'running'")
					?.count ?? 0,
			),
			queuedJobs: Number(
				this.database.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE state = 'queued'")?.count ??
					0,
			),
			controller: "connected" as const,
			...(this.config.socket.ownerUid === undefined ? {} : { socketOwnerUid: this.config.socket.ownerUid }),
			socketMode: this.config.socket.mode,
			socketMaxRequestBytes: this.config.socket.maxRequestBytes,
		};
		return {
			cases,
			attempts,
			profiles,
			workItems,
			stacks,
			classifications,
			policies,
			memory,
			specifications,
			approvals,
			workItemApprovals,
			quickFixProposals,
			feedback,
			questionBriefs,
			artifacts,
			jobs,
			usage,
			evidenceManifests,
			verificationRuns,
			system,
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
				case "work-item.approve":
					result = this.specifications.approveWorkItem(
						request.caseId,
						request.workItemId,
						request.specVersion,
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
					result = await this.setEmergencyStop(request.enabled);
					break;
				case "pane.focus":
					if (this.options.paneFocus) await this.options.paneFocus(request.paneId);
					result = { accepted: true };
					break;
				case "evidence.reproduce": {
					const manifestCase = this.database.get<{ case_id: string; repository: string | null }>(
						"SELECT m.case_id, c.repository FROM evidence_manifests m JOIN cases c ON c.id = m.case_id WHERE m.id = ?",
						request.manifestId,
					);
					if (!manifestCase) throw new Error(`Unknown evidence manifest: ${request.manifestId}`);
					if (manifestCase.case_id !== request.caseId)
						throw new Error("evidence manifest does not belong to the selected case");
					result = await reproduceEvidenceOperation(
						{ operation: "evidence.reproduce", caseId: request.caseId, manifestId: request.manifestId },
						{ database: this.database },
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
				if (
					this.database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", caseId)?.state ===
					"paused-usage"
				) {
					if (this.database.hasPendingUsageStop(caseId))
						throw new Error(`Case ${caseId} cannot resume while a usage stop is pending`);
					const resumed = this.providerScheduler.resumeAfterUsageCase(
						caseId,
						this.options.clock?.() ?? new Date(),
					);
					const state = this.stateMachine.resumeCase(caseId, this.operator, comment);
					return { accepted: true, state, resumedJobs: resumed };
				}
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
			case "approve-quick-fix":
				return this.quickFixes.approve(caseId, this.operator);
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
		const target = scope === "source" ? source : scope === "repository" ? repository : undefined;
		this.database.setRollout(scope, value, this.operator, target);
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
