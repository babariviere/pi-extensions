/** Wire-safe contracts shared by the background-agent controller and dashboard. */

export type BackgroundSource = "manual" | "slack" | "linear" | "datadog";
export type InputKind = "error" | "bug-report" | "feature" | "question" | "maintenance" | "other" | "unknown";
export type ClassificationDisposition = "actionable" | "noise" | "ambiguous";
export type AutonomyDisposition = "quick-fix-candidate" | "spec-required" | "needs-human";

export type CaseState =
	| "intake"
	| "classified"
	| "investigating"
	| "question-analysis"
	| "specification"
	| "awaiting-approval"
	| "implementation"
	| "verification"
	| "pull-request-review"
	| "paused"
	| "paused-usage"
	| "blocked"
	| "retry"
	| "handled"
	| "cancelled";

export type CaseAction =
	| "approve-specification"
	| "request-changes"
	| "resume"
	| "reclassify"
	| "cancel"
	| "mark-handled"
	| "reject";

export type AgentRole = "classifier" | "investigator" | "spec-planner" | "worker" | "verifier";
export type AttemptState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "paused" | "needs-human";
export type VerificationVerdict = "pass" | "fail" | "needs-human";
export type RolloutMode = "observe" | "supervised" | "autonomous-pr";
export type ProviderKind = "anthropic" | "openai";

/** A score is deliberately separate from a boolean decision. */
export interface Score {
	value: number;
	rationale?: string;
}

export interface Confidence {
	score: number;
	rationale: string;
	uncertainties: string[];
}

export interface SourceEvent {
	source: BackgroundSource;
	sourceKey: string;
	revision?: string;
	receivedAt: string;
	title: string;
	body: string;
	fingerprint?: string;
	repository?: string;
	service?: string;
	metadata?: Record<string, unknown>;
}

export interface Classification {
	inputKind: InputKind;
	disposition: ClassificationDisposition;
	actionability: number;
	noise: number;
	confidence: number;
	rationale: string;
	fingerprint?: string;
	policyVersion: string;
	modelVersion: string;
	influentialExamples: string[];
}

export interface ClassifierOutput {
	inputKind: InputKind;
	actionability: number;
	noise: number;
	confidence: number;
	rationale: string;
}

export interface ClassifierExample {
	id: string;
	source?: BackgroundSource;
	inputKind?: InputKind;
	disposition?: ClassificationDisposition;
	correction: Record<string, unknown>;
	provenance: string;
}

export interface MemoryEntry {
	id: string;
	caseId?: string;
	finding: string;
	outcome?: string;
	rootCause?: string;
	evidenceSummary: string;
	confidence: number;
	scope: string;
	approvalStatus: "pending" | "approved" | "rejected";
	supersedesId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface CaseSummary {
	id: string;
	title: string;
	source: BackgroundSource;
	state: CaseState;
	repository?: string;
	priority?: number;
	rollout: RolloutMode;
	createdAt: string;
	updatedAt: string;
}

export interface CaseRecord extends CaseSummary {
	sourceKey: string;
	classification?: Classification;
	autonomy?: AutonomyDisposition;
	confidence?: Confidence;
}

export interface RelatedCase {
	caseId: string;
	type: "duplicate" | "recurrence" | "related";
	score: number;
	rationale: string;
	provenance?: string;
	supersededBy?: string[];
}

export interface AttemptRecord {
	id: string;
	caseId: string;
	role: AgentRole;
	generation: number;
	state: AttemptState;
	profileId?: string;
	model?: string;
	systemdUnit?: string;
	paneId?: string;
	worktree?: string;
	branch?: string;
	heartbeatAt?: string;
	startedAt?: string;
	finishedAt?: string;
	failure?: string;
}

export type EvidencePhase = "base" | "candidate";

export interface EvidenceExpectedResult {
	exitCode: number;
}

export interface EvidenceActualResult {
	exitCode: number | null;
	timedOut: boolean;
	/** Bounded diagnostic captures. Hashes and byte counts describe the complete streams. */
	stdout: string;
	stderr: string;
	outputHash: string;
	outputBytes: number;
	outputTruncated: boolean;
	stdoutHash: string;
	stdoutBytes: number;
	stdoutTruncated: boolean;
	stderrHash: string;
	stderrBytes: number;
	stderrTruncated: boolean;
	artifactChecksums: Record<string, string>;
}

export interface EvidenceCommand {
	/** The executable and argv are persisted separately so replay never invokes a shell. */
	executable: string;
	argv: string[];
	/** @deprecated Use argv. Kept for readers of the initial v1 contract. */
	args?: string[];
	/** A repository-relative working directory. */
	cwd: string;
	/** @deprecated Use cwd. */
	workingDirectory?: string;
	timeoutMs: number;
	/** Names only. Values are supplied from the controller-owned safe environment, never persisted. */
	environment: string[];
	toolVersions?: Record<string, string>;
	phase: EvidencePhase;
	purpose: "reproduction" | "acceptance";
	expected: EvidenceExpectedResult;
	actual?: EvidenceActualResult;
	/** @deprecated Use expected.exitCode and actual.exitCode. */
	expectedExitCode?: number;
	actualExitCode?: number;
	outputHash?: string;
	artifactChecksums?: Record<string, string>;
}

export interface EvidenceManifest {
	version: 1;
	baseSha: string;
	candidateSha: string;
	commands: EvidenceCommand[];
	createdAt: string;
	toolVersions?: Record<string, string>;
	bugReproduction?: boolean;
	acceptanceSummary?: string;
}

export interface VerificationRun {
	id: string;
	manifestId: string;
	verdict: VerificationVerdict;
	confidence: Confidence;
	ciChecks: Record<string, "pass" | "fail" | "pending" | "missing">;
	rationale: string;
	uncertainties: string[];
	replayHistory?: string[];
	createdAt: string;
}

export interface ProviderProfile {
	id: string;
	provider: ProviderKind;
	agentDir: string;
	authFiles: string[];
	allowedModels: string[];
	allowedRoles: AgentRole[];
	maxBackgroundAttempts: number;
	interactiveReserve: number;
	usageStaleAfterMs: number;
}

/** Operator-safe projection of a provider profile. Credential and profile paths are never wire data. */
export interface DashboardProfile {
	id: string;
	provider: ProviderKind;
	allowedModels: string[];
	allowedRoles: AgentRole[];
	maxBackgroundAttempts: number;
	interactiveReserve: number;
	usageStaleAfterMs: number;
	available?: boolean;
	activeAttempts?: number;
	cooldownUntil?: string;
}

export interface DashboardWorkItem {
	id: string;
	caseId: string;
	ordinal: number;
	parentId?: string;
	title: string;
	branch?: string;
	pullRequest?: number;
	state: string;
	createdAt: string;
	updatedAt: string;
}

export interface DashboardStack {
	caseId: string;
	workItemIds: string[];
}

export interface DashboardClassification {
	id: string;
	caseId: string;
	inputKind: InputKind;
	disposition: ClassificationDisposition;
	actionability: number;
	noise: number;
	confidence: number;
	policyVersion: string;
	modelVersion: string;
	createdAt: string;
}

export interface DashboardPolicy {
	id: string;
	scope: string;
	version: string;
	status: "proposed" | "active" | "retired";
	createdAt: string;
	activatedAt?: string;
}

export interface DashboardMemory extends MemoryEntry {
	provenance: string;
	supersededByIds: string[];
}

export interface DashboardSpecification {
	id: string;
	caseId: string;
	version: number;
	summary: string;
	decisions: string[];
	unresolvedQuestions: string[];
	permissions: string[];
	materialHash: string;
	createdAt: string;
}

export interface DashboardApproval {
	id: string;
	caseId: string;
	specVersion: number;
	decision: "approved" | "rejected" | "changes-requested";
	actor: string;
	permissions: string[];
	orderedWorkItemIds: string[];
	createdAt: string;
}

export interface DashboardFeedback {
	id: string;
	caseId?: string;
	classificationId?: string;
	actor: string;
	correction: string;
	createdAt: string;
}

export interface DashboardQuestionBrief {
	id: string;
	caseId: string;
	attemptId?: string;
	question: string;
	findings: string[];
	sources: string[];
	confidence: number;
	uncertainties: string[];
	limits: string;
	createdAt: string;
}

export interface DashboardArtifact {
	id: string;
	caseId?: string;
	attemptId?: string;
	kind: string;
	url?: string;
	hash?: string;
	transcriptReference?: string;
	createdAt: string;
}

export interface DashboardJob {
	id: string;
	caseId: string;
	workItemId?: string;
	role: AgentRole;
	state: AttemptState;
	priority: number;
	claimedBy?: string;
	claimedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface DashboardUsage {
	profileId: string;
	available: boolean;
	activeAttempts: number;
	concurrencyLimit: number;
	interactiveReserve: number;
	cooldownUntil?: string;
	windows: Array<{ quotaWindow: string; used: number; remaining?: number; observedAt: string }>;
}

export interface DashboardEvidenceCommand {
	executable: string;
	argv: string[];
	cwd: string;
	phase: EvidencePhase;
	purpose: "reproduction" | "acceptance";
	expectedExitCode: number;
	actualExitCode?: number | null;
	outputHash?: string;
	outputBytes?: number;
	outputTruncated?: boolean;
}

export interface DashboardEvidenceManifest {
	id: string;
	caseId: string;
	version: number;
	baseSha: string;
	candidateSha: string;
	commands: DashboardEvidenceCommand[];
	createdAt: string;
	toolVersions: Record<string, string>;
}

export interface DashboardVerificationRun {
	id: string;
	manifestId: string;
	verdict: VerificationVerdict;
	confidence: number;
	ciChecks: Record<string, "pass" | "fail" | "pending" | "missing">;
	rationale: string;
	uncertainties: string[];
	replayHistory: string[];
	createdAt: string;
}

export interface DashboardSystemState {
	started: boolean;
	activeAttempts: number;
	queuedJobs: number;
	controller: "connected";
	socketOwnerUid?: number;
	socketMode: number;
	socketMaxRequestBytes: number;
}

export interface SocketContract {
	path: string;
	ownerUid?: number;
	mode: number;
	maxRequestBytes: number;
}

export interface DashboardSnapshot {
	cases: CaseSummary[];
	attempts: AttemptRecord[];
	profiles: DashboardProfile[];
	workItems: DashboardWorkItem[];
	stacks: DashboardStack[];
	classifications: DashboardClassification[];
	policies: DashboardPolicy[];
	memory: DashboardMemory[];
	specifications: DashboardSpecification[];
	approvals: DashboardApproval[];
	feedback: DashboardFeedback[];
	questionBriefs: DashboardQuestionBrief[];
	artifacts: DashboardArtifact[];
	jobs: DashboardJob[];
	usage: DashboardUsage[];
	evidenceManifests: DashboardEvidenceManifest[];
	verificationRuns: DashboardVerificationRun[];
	system: DashboardSystemState;
	rollout: RolloutMode;
	emergencyStop: boolean;
	generatedAt: string;
}

export interface RepositoryConfig {
	id: string;
	root: string;
	gitDir: string;
	requiredChecks: string[];
}

export interface ThresholdConfig {
	actionableMin: number;
	noiseMax: number;
	scopes?: {
		source?: Partial<Record<BackgroundSource, ThresholdConfig>>;
		service?: Record<string, ThresholdConfig>;
		monitor?: Record<string, ThresholdConfig>;
		environment?: Record<string, ThresholdConfig>;
		repository?: Record<string, ThresholdConfig>;
	};
}

export interface BackgroundAgentsConfig {
	configVersion: 1;
	databasePath: string;
	repositories: RepositoryConfig[];
	thresholds: ThresholdConfig;
	pollIntervalsMs: {
		linear: number;
		datadog: number;
		slackReconnect: number;
	};
	profiles: ProviderProfile[];
	systemd: {
		maxRuntimeMs: number;
		memoryLimitBytes: number;
		cpuQuotaPercent: number;
		processLimit: number;
	};
	ci: {
		requiredChecks: string[];
		maxWaitMs: number;
	};
	socket: SocketContract;
	rollout: {
		defaultMode: RolloutMode;
		sourceOverrides: Partial<Record<BackgroundSource, RolloutMode>>;
		repositoryOverrides: Record<string, RolloutMode>;
	};
	backup: {
		directory: string;
		intervalMs: number;
		retention: number;
		syncCommand?: string[];
	};
	sources: BackgroundSourceConfig;
	classifier: ClassifierConfig;
	controller: ControllerIntervals;
}

export interface BackgroundSourceConfig {
	manual: { enabled: boolean };
	slack: { enabled: boolean; url: string; credentialPath?: string };
	linear: {
		enabled: boolean;
		url: string;
		credentialPath?: string;
		query?: string;
		pageSize?: number;
		repositoryMappings: Record<string, string>;
	};
	datadog: {
		enabled: boolean;
		url: string;
		credentialPath?: string;
		monitorQueries: Array<{ id: string; query: string; repository?: string; service?: string }>;
		errorQueries: Array<{ id: string; query: string; repository?: string; service?: string }>;
		repositoryMappings: Record<string, string>;
		overlapMs: number;
	};
}

export interface ClassifierConfig {
	modelVersion: string;
	policyScope?: string;
	exampleLimit: number;
	relatedCaseLimit: number;
}

export interface ControllerIntervals {
	usageMs: number;
	schedulerMs: number;
	heartbeatMs: number;
	recoveryMs: number;
	ciMs: number;
}
