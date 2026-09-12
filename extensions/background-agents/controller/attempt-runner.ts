import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRole, SourceEvent } from "../types.ts";
import type { BackgroundAgentsConfig } from "../types.ts";
import type { BackgroundAgentsDatabase, JobClaim } from "./database.ts";
import { Classifier } from "./classification/classifier.ts";
import { GitRepository } from "./git/repository.ts";
import { backgroundBranch, GitWorktreeManager } from "./git/worktree.ts";
import { GitHubDraftConflictError, GitHubEffects, type GitHubEffectClient } from "./effects/github.ts";
import { BackgroundAgentsStateMachine } from "./state-machine.ts";
import { buildContextManifest, persistContextManifest, type ContextManifest } from "./runtime/context.ts";
import { launchAttemptThroughHerdr, type HerdrAttemptLaunchResult, type HerdrAttemptOptions } from "./runtime/herdr.ts";
import { prepareRuntimeProfile, selectRuntimeProfile } from "./runtime/profiles.ts";
import { waitForTransientService, type TransientServiceCompletion } from "./runtime/systemd.ts";
import {
	InvestigationWorkflow,
	buildInvestigationContext,
	type InvestigationOutput,
} from "./workflows/investigation.ts";
import {
	DEFAULT_QUESTION_LIMITS,
	buildQuestionContext,
	QuestionWorkflow,
	type PrivateQuestionBrief,
} from "./workflows/question.ts";
import { SpecificationWorkflow, type SpecificationDraft } from "./workflows/specification.ts";
import { createEvidenceManifest, formatEvidenceMarkdown } from "./verification/evidence.ts";
import { verifyEvidence } from "./verification/verifier.ts";

const require = createRequire(import.meta.url);
export const VERIFICATION_RESULT_VERSION = 1 as const;
export const VERIFICATION_RESULT_FILE = "verification-result.json";

const VERIFIER_SERVICE = String.raw`import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [verifierModule, inputPath, artifactPath, verificationPath, attemptId, jobId, repository, requiredChecks] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inputPath, "utf8"));
const { verifyEvidence } = await import(pathToFileURL(verifierModule).href);
const report = await verifyEvidence({
  manifest: input.manifest,
  repository,
  prNumber: input.prNumber,
  requiredChecks: JSON.parse(requiredChecks),
});
writeFileSync(verificationPath, JSON.stringify({ version: 1, report }) + "\n", { mode: 0o600 });
writeFileSync(artifactPath, JSON.stringify({ version: 1, attemptId, jobId, role: "verifier", state: "succeeded", output: { verdict: report.verdict } }) + "\n", { mode: 0o600 });`;

export function combinedRequiredChecks(globalChecks: readonly string[], repositoryChecks: readonly string[]): string[] {
	return [...new Set([...globalChecks, ...repositoryChecks])];
}

export const ATTEMPT_RESULT_VERSION = 1 as const;
export const ATTEMPT_RESULT_FILE = "result.json";

export interface AttemptResultArtifact {
	version: 1;
	attemptId: string;
	jobId: string;
	role: AgentRole;
	state: "succeeded";
	output: Record<string, unknown>;
}

export interface ProductionAttemptRunnerOptions {
	config: BackgroundAgentsConfig;
	attemptRoot?: string;
	worktreeRoot?: string;
	roleDirectory?: string;
	launch?: (
		options: HerdrAttemptOptions,
		dependencies?: Parameters<typeof launchAttemptThroughHerdr>[1],
	) => Promise<HerdrAttemptLaunchResult>;
	waitForUnit?: (unit: string, timeoutMs: number) => Promise<TransientServiceCompletion>;
	repositoryFactory?: (root: string) => GitRepository;
	worktreeFactory?: (repository: GitRepository, root: string) => GitWorktreeManager;
	/** Injected for tests; production supplies the argv-only GitHub adapter from the controller entrypoint. */
	githubClient?: GitHubEffectClient;
	githubClientFactory?: (repository: GitRepository) => GitHubEffectClient;
}

const ROLE_ORDINAL: Record<AgentRole, number> = {
	classifier: 900001,
	investigator: 900002,
	"spec-planner": 900003,
	worker: 1,
	verifier: 900004,
};

const WRAPPER = String.raw`import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const resultPath = process.argv[2];
const attemptId = process.argv[3];
const jobId = process.argv[4];
const role = process.argv[5];
const args = process.argv.slice(6);
let stdout = "";
let stderr = "";
const child = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", chunk => { stdout += chunk.toString(); process.stdout.write(chunk); });
child.stderr.on("data", chunk => { stderr += chunk.toString(); process.stderr.write(chunk); });
child.once("error", error => { stderr += String(error); });
child.once("close", code => {
  if (!existsSync(resultPath)) {
    let output;
    try { output = JSON.parse(stdout.trim()); }
    catch { output = { text: stdout.trim(), stderr: stderr.trim() }; }
    writeFileSync(resultPath, JSON.stringify({ version: 1, attemptId, jobId, role, state: "succeeded", output }) + "\n", { mode: 0o600 });
  }
  process.exitCode = code ?? 1;
});`;

function requiredObject(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
	return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be non-empty`);
	return value.trim();
}

function requiredList(value: unknown, field: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	return value;
}

function validateRoleOutput(role: AgentRole, value: unknown, questionAnalysis = false): Record<string, unknown> {
	const output = requiredObject(value, `${role} output`);
	if (role === "classifier") {
		requiredText(output.inputKind, "classifier inputKind");
		for (const field of ["actionability", "noise", "confidence"])
			if (typeof output[field] !== "number" || !Number.isFinite(output[field]))
				throw new Error(`classifier ${field} must be numeric`);
		requiredText(output.rationale, "classifier rationale");
	}
	if (role === "investigator") {
		if (questionAnalysis) {
			const questionFields = new Set(["findings", "sources", "confidence", "uncertainties"]);
			if (Object.keys(output).some((field) => !questionFields.has(field)))
				throw new Error("question result contains fields outside the private brief contract");
			if (!("findings" in output)) throw new Error("question findings are required");
			requiredList(output.sources, "question sources");
			if (
				typeof output.confidence !== "number" ||
				!Number.isFinite(output.confidence) ||
				output.confidence < 0 ||
				output.confidence > 100
			)
				throw new Error("question confidence must be between 0 and 100");
			requiredList(output.uncertainties, "question uncertainties");
			return output;
		}
		if (!["quick-fix-candidate", "spec-required", "needs-human"].includes(String(output.autonomy)))
			throw new Error("investigator autonomy is invalid");
		requiredText(output.findings, "investigator findings");
		if (
			typeof output.confidence !== "number" ||
			!Number.isFinite(output.confidence) ||
			output.confidence < 0 ||
			output.confidence > 100
		)
			throw new Error("investigator confidence must be between 0 and 100");
		requiredList(output.uncertainties, "investigator uncertainties");
	}
	if (role === "spec-planner") {
		requiredText(output.plannerSummary, "plannerSummary");
		requiredList(output.decisions, "decisions");
		requiredList(output.unresolvedQuestions, "unresolvedQuestions");
		requiredList(output.permissions, "permissions");
		if (!("specification" in output)) throw new Error("specification is required");
	}
	if (role === "worker") {
		requiredText(output.commitSha, "worker commitSha");
		if (!("evidenceManifest" in output)) throw new Error("worker evidenceManifest is required");
	}
	if (role === "verifier" && !["pass", "fail", "needs-human"].includes(String(output.verdict)))
		throw new Error("verifier verdict is invalid");
	return output;
}

function validateArtifact(
	value: unknown,
	claim: JobClaim,
	role: AgentRole,
	questionAnalysis = false,
): AttemptResultArtifact {
	const artifact = requiredObject(value, "attempt result artifact");
	const fields = new Set(["version", "attemptId", "jobId", "role", "state", "output"]);
	if (Object.keys(artifact).some((field) => !fields.has(field)))
		throw new Error("attempt result artifact has unknown fields");
	if (artifact.version !== ATTEMPT_RESULT_VERSION) throw new Error("unsupported attempt result artifact version");
	if (artifact.attemptId !== claim.attemptId || artifact.jobId !== claim.jobId || artifact.role !== role)
		throw new Error("attempt result artifact identity does not match the running attempt");
	if (artifact.state !== "succeeded") throw new Error("attempt result artifact is not successful");
	const output = validateRoleOutput(role, artifact.output, questionAnalysis);
	return { version: 1, attemptId: claim.attemptId, jobId: claim.jobId, role, state: "succeeded", output };
}

function latestEvent(database: BackgroundAgentsDatabase, caseId: string): SourceEvent {
	const row = database.get<Record<string, unknown>>(
		"SELECT id FROM source_events WHERE case_id = ? ORDER BY received_at DESC, created_at DESC LIMIT 1",
		caseId,
	);
	if (!row) throw new Error(`No source event exists for case ${caseId}`);
	const event = database.getSourceEvent(String(row.id));
	if (!event) throw new Error(`Source event ${String(row.id)} is unavailable`);
	return event;
}

function repositoryConfig(config: BackgroundAgentsConfig, database: BackgroundAgentsDatabase, caseId: string) {
	const value = database.get<{ repository: string | null }>(
		"SELECT repository FROM cases WHERE id = ?",
		caseId,
	)?.repository;
	if (!value) return undefined;
	const found = config.repositories.find((item) => item.id === value || item.root === value);
	if (!found) throw new Error(`case repository is not configured: ${value}`);
	return found;
}

function attemptContext(
	database: BackgroundAgentsDatabase,
	claim: JobClaim,
	role: AgentRole,
	resultPath: string,
): ContextManifest {
	const row = database.get<{
		case_id: string;
		case_state: string;
		work_item_id: string | null;
		manifest_id: string | null;
		recovery_checkpoint_id: string | null;
	}>(
		"SELECT j.case_id, c.state AS case_state, j.work_item_id, j.manifest_id, a.recovery_checkpoint_id FROM jobs j JOIN cases c ON c.id = j.case_id JOIN attempts a ON a.id = ? WHERE j.id = ?",
		claim.attemptId,
		claim.jobId,
	);
	if (!row) throw new Error(`Unknown job: ${claim.jobId}`);
	const base = { resultPath, generation: claim.generation, jobId: claim.jobId };
	const recoveryCheckpoint = row.recovery_checkpoint_id
		? database.trustedCheckpoint(row.recovery_checkpoint_id)
		: undefined;
	const recoveryContext = recoveryCheckpoint ? { recoveryCheckpoint } : {};
	if (role === "classifier") {
		return buildContextManifest({
			attemptId: claim.attemptId,
			caseId: row.case_id,
			role,
			context: { event: latestEvent(database, row.case_id), ...recoveryContext, ...base },
		});
	}
	if (role === "investigator" && row.case_state === "question-analysis")
		return buildContextManifest({
			attemptId: claim.attemptId,
			caseId: row.case_id,
			role,
			context: {
				...buildQuestionContext(
					database,
					row.case_id,
					latestEvent(database, row.case_id).body,
					DEFAULT_QUESTION_LIMITS,
				),
				...recoveryContext,
				...base,
			},
		});
	if (role === "investigator")
		return buildContextManifest({
			attemptId: claim.attemptId,
			caseId: row.case_id,
			role,
			context: { ...buildInvestigationContext(database, row.case_id), ...recoveryContext, ...base },
		});
	if (role === "spec-planner") {
		const context = new SpecificationWorkflow(database).context(row.case_id);
		return buildContextManifest({
			attemptId: claim.attemptId,
			caseId: row.case_id,
			role,
			context: { ...context, ...recoveryContext, ...base },
		});
	}
	const workItem = row.work_item_id
		? database.get<Record<string, unknown>>("SELECT * FROM work_items WHERE id = ?", row.work_item_id)
		: undefined;
	const context: Record<string, unknown> = {
		case: database.get<Record<string, unknown>>(
			"SELECT id, title, state, repository FROM cases WHERE id = ?",
			row.case_id,
		),
		workItem,
		latestSpecification: database.getLatestSpecification(row.case_id),
		...recoveryContext,
		...base,
	};
	if (role === "verifier") {
		const manifestRow = row.manifest_id
			? { id: row.manifest_id }
			: database.get<{ id: string }>(
					"SELECT id FROM evidence_manifests WHERE case_id = ? ORDER BY version DESC LIMIT 1",
					row.case_id,
				);
		if (!manifestRow) throw new Error(`No evidence manifest exists for case ${row.case_id}`);
		context.evidenceManifest = database.getEvidenceManifest(manifestRow.id);
	}
	return buildContextManifest({ attemptId: claim.attemptId, caseId: row.case_id, role, context });
}

export class ProductionAttemptRunner {
	private readonly options: Required<Pick<ProductionAttemptRunnerOptions, "config">> & ProductionAttemptRunnerOptions;
	constructor(options: ProductionAttemptRunnerOptions) {
		this.options = options;
	}

	async run(
		claim: JobClaim,
		database: BackgroundAgentsDatabase,
	): Promise<{ state: "succeeded" | "failed" | "needs-human"; failure?: string }> {
		const job = database.get<{
			case_id: string;
			role: AgentRole;
			work_item_id: string | null;
			manifest_id: string | null;
			expected_base_sha: string | null;
			expected_candidate_sha: string | null;
		}>(
			"SELECT case_id, role, work_item_id, manifest_id, expected_base_sha, expected_candidate_sha FROM jobs WHERE id = ?",
			claim.jobId,
		);
		if (!job) return { state: "failed", failure: `Unknown job: ${claim.jobId}` };
		const role = job.role;
		const attemptRoot = resolve(
			this.options.attemptRoot ?? join(dirname(this.options.config.databasePath), "background-attempts"),
		);
		const attemptDirectory = join(attemptRoot, job.case_id, claim.attemptId);
		const resultPath = join(attemptDirectory, ATTEMPT_RESULT_FILE);
		try {
			mkdirSync(attemptDirectory, { recursive: true, mode: 0o700 });
			const context = attemptContext(database, claim, role, resultPath);
			const repository = repositoryConfig(this.options.config, database, job.case_id);
			let worktreeDirectory = join(attemptRoot, job.case_id, `${claim.attemptId}-workspace`);
			let branch: string | undefined;
			let baseBranch = repository?.defaultBaseBranch ?? "main";
			let baseRef = baseBranch;
			let githubEffects: GitHubEffects | undefined;
			if (repository) {
				const git = (this.options.repositoryFactory ?? ((root) => new GitRepository(root)))(repository.root);
				const manager = (this.options.worktreeFactory ?? ((repo, root) => new GitWorktreeManager(repo, root)))(
					git,
					this.options.worktreeRoot ??
						join(dirname(this.options.config.databasePath), "background-worktrees", repository.id),
				);
				baseRef = (await git.checked(["rev-parse", `${baseBranch}^{commit}`])).trim();
				if (role === "worker" && job.work_item_id) {
					const parent = database.get<{ ordinal: number; branch: string | null; state: string }>(
						"SELECT parent.ordinal, parent.branch, parent.state FROM work_items item JOIN work_items parent ON parent.id = item.parent_id WHERE item.id = ?",
						job.work_item_id,
					);
					if (parent) {
						if (parent.state !== "verified") throw new Error("worker parent work item is not verified");
						baseBranch = parent.branch ?? backgroundBranch(job.case_id, parent.ordinal);
						baseRef = (await git.checked(["rev-parse", `${baseBranch}^{commit}`])).trim();
					}
				}
				if (role === "verifier") {
					const manifestRow = database.get<{ id: string; base_sha: string; candidate_sha: string }>(
						job.manifest_id
							? "SELECT id, base_sha, candidate_sha FROM evidence_manifests WHERE id = ?"
							: "SELECT id, base_sha, candidate_sha FROM evidence_manifests WHERE case_id = ? ORDER BY version DESC LIMIT 1",
						job.manifest_id ?? job.case_id,
					);
					if (!manifestRow) throw new Error(`No evidence manifest exists for case ${job.case_id}`);
					if (
						(job.expected_base_sha && job.expected_base_sha !== manifestRow.base_sha) ||
						(job.expected_candidate_sha && job.expected_candidate_sha !== manifestRow.candidate_sha)
					)
						throw new Error("verifier job is not bound to the manifest commits");
					baseRef = manifestRow.candidate_sha;
				}
				const ordinal = job.work_item_id
					? Number(
							database.get<{ ordinal: number }>("SELECT ordinal FROM work_items WHERE id = ?", job.work_item_id)
								?.ordinal,
						)
					: ROLE_ORDINAL[role];
				if (!Number.isSafeInteger(ordinal) || ordinal <= 0) throw new Error("work item ordinal is invalid");
				const ensured = await manager.ensure({
					caseId: job.case_id,
					ordinal: ordinal + (role === "worker" ? 0 : ROLE_ORDINAL[role]),
					owner: claim.attemptId,
					baseRef,
				});
				worktreeDirectory = ensured.path;
				branch = ensured.branch;
				database.run(
					"UPDATE attempts SET worktree = ?, branch = ? WHERE id = ?",
					worktreeDirectory,
					branch ?? null,
					claim.attemptId,
				);
				if (role === "worker" && job.work_item_id && branch) {
					database.run(
						"UPDATE work_items SET branch = ?, worktree = ?, updated_at = ? WHERE id = ?",
						branch,
						worktreeDirectory,
						new Date().toISOString(),
						job.work_item_id,
					);
				}
				if (
					role === "verifier" &&
					job.work_item_id &&
					(this.options.githubClient !== undefined || this.options.githubClientFactory !== undefined)
				) {
					const pullRequest = database.get<{ pull_request: number | null }>(
						"SELECT pull_request FROM work_items WHERE id = ?",
						job.work_item_id,
					);
					if (!pullRequest?.pull_request) throw new Error("verifier job is not bound to a pull request");
				}
				const client = this.options.githubClientFactory?.(git) ?? this.options.githubClient;
				if (client) githubEffects = new GitHubEffects(database, client, { owner: `background:${claim.attemptId}` });
			} else {
				if (role === "worker" || role === "verifier") throw new Error(`${role} requires a configured repository`);
				mkdirSync(worktreeDirectory, { recursive: true, mode: 0o700 });
			}
			if (role === "worker" && job.work_item_id) {
				const workItemState = database.get<{ state: string }>(
					"SELECT state FROM work_items WHERE id = ?",
					job.work_item_id,
				)?.state;
				if (workItemState === "queued")
					new BackgroundAgentsStateMachine(database).transitionWorkItem(
						job.work_item_id,
						"implementation",
						"worker",
						"worker attempt started",
					);
			}
			const selected = selectRuntimeProfile(this.options.config, role, {
				attemptDir: attemptDirectory,
				profileId: claim.profileId,
				model: claim.model,
			});
			const runtime = prepareRuntimeProfile(selected);
			const rolePromptPath = this.options.roleDirectory
				? join(this.options.roleDirectory, `${role}.md`)
				: fileURLToPath(new URL(`../roles/${role}.md`, import.meta.url));
			const contextPath = join(attemptDirectory, "context-manifest.json");
			const contextArtifact = persistContextManifest(context, { attemptDirectory, database });
			database.recordTrustedCheckpoint({
				attemptId: claim.attemptId,
				kind: "context",
				path: contextArtifact.path,
				digest: contextArtifact.hash,
				metadata: {
					hash: contextArtifact.hash,
					artifactId: contextArtifact.artifactId,
					artifactReference: contextArtifact.artifactId ?? contextArtifact.path,
				},
			});
			const questionAnalysis =
				role === "investigator" &&
				database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", job.case_id)?.state ===
					"question-analysis";
			const prompt = `Read the persisted context manifest at ${contextPath} before acting. Write a version ${ATTEMPT_RESULT_VERSION} result artifact to ${resultPath}. It must be JSON with version ${ATTEMPT_RESULT_VERSION}, attemptId ${claim.attemptId}, jobId ${claim.jobId}, role ${role}, state succeeded, and an output object containing your deliverable. Do not claim success without this artifact.${questionAnalysis ? " This is question-analysis: output only a private brief with findings, sources, confidence, and uncertainties. Do not propose a specification or make mutations." : ""}`;
			const launch = this.options.launch ?? launchAttemptThroughHerdr;
			const verificationPath = join(attemptDirectory, VERIFICATION_RESULT_FILE);
			let command: string | undefined;
			let commandArgsPrefix: string[] | undefined;
			if (role === "verifier" && !this.options.launch) {
				if (!repository) throw new Error("verifier requires a configured repository");
				const verifierInputPath = join(attemptDirectory, "verifier-input.json");
				const manifest = database.getEvidenceManifest(job.manifest_id ?? "");
				if (!manifest) throw new Error("verifier evidence manifest is unavailable");
				const pullRequest = job.work_item_id
					? database.get<{ pull_request: number | null }>(
							"SELECT pull_request FROM work_items WHERE id = ?",
							job.work_item_id,
						)
					: undefined;
				await writeFile(
					verifierInputPath,
					JSON.stringify({
						manifest,
						version: VERIFICATION_RESULT_VERSION,
						prNumber: pullRequest?.pull_request,
					}) + "\\n",
					{ mode: 0o600 },
				);
				const loader = require.resolve("tsx/esm");
				const verifierModule = fileURLToPath(new URL("./verification/verifier.ts", import.meta.url));
				command = process.execPath;
				commandArgsPrefix = [
					"--import",
					loader,
					join(attemptDirectory, "verifier-service.mjs"),
					verifierModule,
					verifierInputPath,
					resultPath,
					verificationPath,
					claim.attemptId,
					claim.jobId,
					repository.root,
					JSON.stringify(combinedRequiredChecks(this.options.config.ci.requiredChecks, repository.requiredChecks)),
				];
				writeFileSync(join(attemptDirectory, "verifier-service.mjs"), VERIFIER_SERVICE, { mode: 0o700 });
			}
			if (!this.options.launch) {
				const wrapperPath = join(attemptDirectory, "runner.mjs");
				writeFileSync(wrapperPath, WRAPPER, { mode: 0o700 });
				chmodSync(wrapperPath, 0o700);
			}
			const launched = await launch(
				{
					database,
					attemptId: claim.attemptId,
					caseId: job.case_id,
					role,
					attemptDirectory,
					worktreeDirectory,
					primaryCheckout: repository?.root ?? attemptDirectory,
					gitDirectory: repository?.gitDir ?? attemptDirectory,
					context,
					contextArtifact,
					runtime,
					rolePromptPath,
					limits: this.options.config.systemd,
					model: claim.model,
					prompt,
					...(repository ? {} : { preflight: { platform: "linux", paths: [] } }),
					...(this.options.launch
						? {}
						: {
								command: process.execPath,
								commandArgsPrefix: [
									join(attemptDirectory, "runner.mjs"),
									resultPath,
									claim.attemptId,
									claim.jobId,
									role,
								],
							}),
					...(command ? { command, commandArgsPrefix } : {}),
				},
				this.options.launch ? {} : undefined,
			);
			const completion = await (
				this.options.waitForUnit ?? ((unit, timeoutMs) => waitForTransientService(unit, { timeoutMs }))
			)(launched.unit, this.options.config.systemd.maxRuntimeMs);
			if (completion.state !== "succeeded")
				return { state: "failed", failure: completion.reason ?? "attempt unit failed" };
			let rawArtifact: unknown;
			try {
				rawArtifact = JSON.parse(await readFile(resultPath, "utf8"));
			} catch {
				throw new Error("attempt result artifact is missing or invalid");
			}
			const artifact = validateArtifact(rawArtifact, claim, role, questionAnalysis);
			let verificationReport: unknown;
			if (role === "verifier") {
				try {
					const stored = JSON.parse(await readFile(verificationPath, "utf8")) as {
						version?: number;
						report?: unknown;
					};
					if (stored.version !== VERIFICATION_RESULT_VERSION || !stored.report)
						throw new Error("verification result has an unsupported version");
					verificationReport = stored.report;
				} catch (error) {
					if (!this.options.launch)
						throw new Error("verifier service result is missing or invalid", { cause: error });
					verificationReport = {
						verdict: (artifact.output as { verdict?: string }).verdict ?? "needs-human",
						confidence: { score: 0, rationale: "test verifier artifact", uncertainties: [] },
						ciChecks: {},
						rationale: "test verifier artifact",
						uncertainties: [],
						replay: {
							passed: false,
							clean: false,
							ancestry: false,
							commands: [],
							rationale: "test verifier artifact",
							uncertainties: [],
						},
						ci: { checks: {}, results: [], allRequiredPassed: true, missing: [], uncertainties: [] },
						candidateSha: job.expected_candidate_sha ?? "",
					};
				}
			}
			database.createArtifact({
				caseId: job.case_id,
				attemptId: claim.attemptId,
				kind: "attempt-result",
				path: resultPath,
				hash: createHash("sha256")
					.update(await readFile(resultPath))
					.digest("hex"),
				metadata: { version: artifact.version, role },
			});
			await this.applyOutput(
				database,
				claim,
				job,
				artifact.output,
				repository?.root,
				worktreeDirectory,
				attemptDirectory,
				baseRef,
				verificationReport,
				baseBranch,
				repository?.remote,
				githubEffects,
				repository ? combinedRequiredChecks(this.options.config.ci.requiredChecks, repository.requiredChecks) : [],
			);
			return { state: "succeeded" };
		} catch (error) {
			const failure = error instanceof Error ? error.message : String(error);
			return {
				state:
					error instanceof GitHubDraftConflictError ||
					failure.includes("result artifact") ||
					failure.includes("output")
						? "needs-human"
						: "failed",
				failure,
			};
		}
	}

	private async applyOutput(
		database: BackgroundAgentsDatabase,
		claim: JobClaim,
		job: {
			case_id: string;
			role: AgentRole;
			work_item_id: string | null;
			manifest_id: string | null;
			expected_base_sha: string | null;
			expected_candidate_sha: string | null;
		},
		output: Record<string, unknown>,
		repository: string | undefined,
		worktree: string,
		attemptDirectory: string,
		baseRef: string,
		verificationReport?: unknown,
		baseBranch = "main",
		remote = "origin",
		githubEffects?: GitHubEffects,
		requiredChecks: readonly string[] = [],
	): Promise<void> {
		if (job.role === "classifier") {
			const event = latestEvent(database, job.case_id);
			const classifier = new Classifier({
				database,
				launch: async () => output,
				modelVersion: this.options.config.classifier.modelVersion,
				thresholds: this.options.config.thresholds,
				policyScope: this.options.config.classifier.policyScope,
				exampleLimit: this.options.config.classifier.exampleLimit,
				relatedCaseLimit: this.options.config.classifier.relatedCaseLimit,
			});
			const result = await classifier.classify(job.case_id, event);
			const state = database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", job.case_id)?.state;
			if (state === "intake") database.transitionCase(job.case_id, "classified", "classifier", "input classified");
			if (result.classification.inputKind === "question" || result.classification.disposition === "actionable") {
				const current = database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", job.case_id)?.state;
				if (current === "classified")
					database.transitionCase(job.case_id, "investigating", "classifier", "investigation queued");
				if (
					!database.get(
						"SELECT id FROM jobs WHERE case_id = ? AND role = 'investigator' AND state IN ('queued', 'running')",
						job.case_id,
					)
				)
					database.createJob({ caseId: job.case_id, role: "investigator" });
			}
			return;
		}
		if (job.role === "investigator") {
			const caseState = database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", job.case_id)?.state;
			if (caseState === "question-analysis") {
				const event = latestEvent(database, job.case_id);
				new QuestionWorkflow(database).record(
					job.case_id,
					event.body,
					output as unknown as PrivateQuestionBrief,
					DEFAULT_QUESTION_LIMITS,
					claim.attemptId,
				);
				return;
			}
			const investigation = output as unknown as InvestigationOutput;
			new InvestigationWorkflow(database).record(job.case_id, investigation, claim.attemptId);
			if (investigation.autonomy !== "needs-human") new SpecificationWorkflow(database).start(job.case_id);
			return;
		}
		if (job.role === "spec-planner") {
			new SpecificationWorkflow(database).recordPlannerResult(job.case_id, output as unknown as SpecificationDraft);
			return;
		}
		if (job.role === "worker") {
			if (!repository || !job.work_item_id) throw new Error("worker output has no repository or work item");
			const git = (this.options.repositoryFactory ?? ((root) => new GitRepository(root)))(repository);
			const commitSha = (await git.checked(["rev-parse", "HEAD"], worktree)).trim();
			if (output.commitSha !== commitSha)
				throw new Error("worker commitSha does not match discovered worktree HEAD");
			const input = requiredObject(output.evidenceManifest, "evidenceManifest") as unknown as Parameters<
				typeof createEvidenceManifest
			>[0];
			if (input.baseSha !== baseRef)
				throw new Error("worker evidence manifest baseSha does not match controller assignment");
			const manifest = createEvidenceManifest({
				...input,
				baseSha: baseRef,
				candidateSha: commitSha,
			});
			const manifestPath = join(attemptDirectory, "evidence-manifest.json");
			await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
			const manifestBytes = await readFile(manifestPath);
			database.createArtifact({
				caseId: job.case_id,
				attemptId: claim.attemptId,
				kind: "evidence-manifest",
				path: manifestPath,
				hash: createHash("sha256").update(manifestBytes).digest("hex"),
				metadata: { version: manifest.version },
			});
			const manifestId = database.createEvidenceManifest({ caseId: job.case_id, manifest });
			const workItemBranch = database.get<{ branch: string | null }>(
				"SELECT branch FROM work_items WHERE id = ?",
				job.work_item_id,
			)?.branch;
			if (!workItemBranch) throw new Error("worker branch is unavailable");
			database.run(
				"UPDATE work_items SET branch = ?, worktree = ?, updated_at = ? WHERE id = ?",
				workItemBranch,
				worktree,
				new Date().toISOString(),
				job.work_item_id,
			);
			if (githubEffects) {
				await githubEffects.pushBranch({ worktree, branch: workItemBranch, remote, expectedHeadSha: commitSha });
				const title = database.get<{ title: string }>(
					"SELECT title FROM work_items WHERE id = ?",
					job.work_item_id,
				)?.title;
				if (!title) throw new Error("worker work item title is unavailable");
				const body = formatEvidenceMarkdown(manifest);
				const pullRequest = await githubEffects.createDraftPullRequest({
					worktree,
					branch: workItemBranch,
					base: baseBranch,
					title,
					body,
				});
				if (pullRequest.base !== baseBranch)
					throw new Error("GitHub pull request base does not match controller assignment");
				if (pullRequest.baseSha && pullRequest.baseSha.toLowerCase() !== baseRef.toLowerCase())
					throw new Error("GitHub pull request base SHA does not match controller assignment");
				database.run(
					"UPDATE work_items SET branch = ?, worktree = ?, pull_request = ?, updated_at = ? WHERE id = ?",
					workItemBranch,
					worktree,
					pullRequest.number,
					new Date().toISOString(),
					job.work_item_id,
				);
				await githubEffects.updatePullRequest(pullRequest.number, { title, body });
			}
			const machine = new BackgroundAgentsStateMachine(database);
			const state = database.get<{ state: string }>(
				"SELECT state FROM work_items WHERE id = ?",
				job.work_item_id,
			)?.state;
			if (state === "queued")
				machine.transitionWorkItem(job.work_item_id, "implementation", "worker", "worker started");
			if (state === "queued" || state === "implementation")
				machine.transitionWorkItem(job.work_item_id, "verification", "worker", "worker completed");
			const caseState = database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", job.case_id)?.state;
			if (caseState === "implementation")
				database.transitionCase(job.case_id, "verification", "worker", "worker completed");
			if (
				!database.get(
					"SELECT id FROM jobs WHERE case_id = ? AND work_item_id = ? AND role = 'verifier' AND state IN ('queued', 'running')",
					job.case_id,
					job.work_item_id,
				)
			)
				database.createJob({
					caseId: job.case_id,
					workItemId: job.work_item_id,
					role: "verifier",
					manifestId,
					expectedBaseSha: manifest.baseSha,
					expectedCandidateSha: manifest.candidateSha,
				});
			return;
		}
		if (job.role === "verifier") {
			if (!repository) throw new Error("verifier output has no repository");
			const row = database.get<{ id: string; base_sha: string; candidate_sha: string }>(
				job.manifest_id
					? "SELECT id, base_sha, candidate_sha FROM evidence_manifests WHERE id = ?"
					: "SELECT id, base_sha, candidate_sha FROM evidence_manifests WHERE case_id = ? ORDER BY version DESC LIMIT 1",
				job.manifest_id ?? job.case_id,
			);
			if (!row) throw new Error("verifier has no evidence manifest");
			if (
				(job.expected_base_sha && job.expected_base_sha !== row.base_sha) ||
				(job.expected_candidate_sha && job.expected_candidate_sha !== row.candidate_sha)
			)
				throw new Error("verifier job is not bound to the manifest commits");
			const manifest = database.getEvidenceManifest(row.id);
			if (!manifest) throw new Error("verifier evidence manifest is unavailable");
			const report = verificationReport as Awaited<ReturnType<typeof verifyEvidence>>;
			if (!report || !["pass", "fail", "needs-human"].includes(report.verdict))
				throw new Error("verifier result is missing or invalid");
			const verificationRunId = database.createVerificationRun({
				manifestId: row.id,
				report,
				resultVersion: VERIFICATION_RESULT_VERSION,
			});
			if (report.verdict === "pass") {
				if (
					githubEffects &&
					(report.candidateSha.toLowerCase() !== manifest.candidateSha.toLowerCase() ||
						!report.ci.allRequiredPassed ||
						requiredChecks.some((check) => report.ciChecks[check] !== "pass"))
				)
					throw new Error("verification pass is not bound to the exact manifest SHA and required CI");
				if (githubEffects) {
					const pullRequest = database.get<{ pull_request: number | null }>(
						"SELECT pull_request FROM work_items WHERE id = ?",
						job.work_item_id,
					);
					if (!pullRequest?.pull_request) throw new Error("verified work item has no pull request");
					const ready = await githubEffects.readyForReview({
						reference: pullRequest.pull_request,
						verifiedCommit: manifest.candidateSha,
						verificationPassed: true,
						requiredCiPassed: report.ci.allRequiredPassed,
						manifestId: row.id,
						verificationRunId,
						requiredChecks,
					});
					if (ready.status === "blocked") throw new Error("pull request head changed before readiness");
				}
				if (job.work_item_id)
					if (
						database.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", job.work_item_id)
							?.state === "verification"
					)
						new BackgroundAgentsStateMachine(database).transitionWorkItem(
							job.work_item_id,
							"verified",
							"verifier",
							"independent verification passed",
						);
				if (githubEffects) {
					const branches = database
						.all<{ branch: string }>(
							"SELECT branch FROM work_items WHERE case_id = ? AND state = 'verified' AND branch IS NOT NULL AND pull_request IS NOT NULL ORDER BY ordinal",
							job.case_id,
						)
						.map((item) => item.branch);
					await githubEffects.linkStack(branches);
				}
				new SpecificationWorkflow(database).queueNextWorker(job.case_id);
				const state = database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", job.case_id)?.state;
				if (state === "verification")
					database.transitionCase(
						job.case_id,
						"pull-request-review",
						"verifier",
						"independent verification passed",
					);
			} else if (report.verdict === "fail") {
				const state = database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", job.case_id)?.state;
				if (state === "verification")
					database.transitionCase(job.case_id, "blocked", "verifier", "independent verification failed");
			}
		}
	}
}

export function createProductionAttemptRunner(options: ProductionAttemptRunnerOptions): ProductionAttemptRunner {
	return new ProductionAttemptRunner(options);
}
