import type { Confidence, EvidenceManifest, VerificationRun, VerificationVerdict } from "../../types.ts";
import { spawnGithubVerificationRunner, verifyPullRequestCi, type CiVerification } from "./ci.ts";
import { replayEvidence, type ReplayProcessRunner, type ReplayResult } from "./reproduce.ts";

export interface VerificationInput {
	manifest: EvidenceManifest;
	repository: string;
	prNumber?: number;
	requiredChecks?: readonly string[];
	runner?: ReplayProcessRunner;
	environment?: NodeJS.ProcessEnv;
	now?: () => Date;
	githubRunner?: ReplayProcessRunner;
	maxWaitMs?: number;
	clock?: () => number;
	sleep?: (ms: number) => Promise<void>;
	onCiResult?: (result: CiVerification) => void | Promise<void>;
}

export interface VerificationReport extends Omit<VerificationRun, "id" | "manifestId" | "version" | "createdAt"> {
	replay: ReplayResult;
	ci: CiVerification;
	candidateSha: string;
}

export interface ReplayVerificationInput {
	manifest: EvidenceManifest;
	replay: ReplayResult;
	prNumber?: number;
	requiredChecks?: readonly string[];
	githubRunner?: ReplayProcessRunner;
	repository?: string;
	maxWaitMs?: number;
	clock?: () => number;
	sleep?: (ms: number) => Promise<void>;
	onCiResult?: (result: CiVerification) => void | Promise<void>;
}

function confidence(verdict: VerificationVerdict, replay: ReplayResult, ci: CiVerification): Confidence {
	if (verdict === "pass")
		return { score: 95, rationale: "all replayed evidence and required CI passed", uncertainties: [] };
	if (verdict === "fail")
		return {
			score: 0,
			rationale: replay.rationale,
			uncertainties: [...replay.uncertainties, ...ci.uncertainties],
		};
	return {
		score: 40,
		rationale: "evidence is incomplete or requires a human check",
		uncertainties: [...replay.uncertainties, ...ci.uncertainties],
	};
}

/** Independent verifier boundary. It receives a manifest, never worker assertions. */
export async function verifyReplayAndGithub(input: ReplayVerificationInput): Promise<VerificationReport> {
	const requiredChecks = [...(input.requiredChecks ?? [])];
	let ci: CiVerification = {
		checks: {},
		results: [],
		allRequiredPassed: requiredChecks.length === 0,
		missing: [],
		uncertainties: [],
	};
	const replay = input.replay;
	const uncertainties = [...replay.uncertainties];
	if (replay.passed && input.prNumber !== undefined) {
		try {
			ci = await verifyPullRequestCi({
				reference: input.prNumber,
				candidateSha: input.manifest.candidateSha,
				requiredChecks,
				runner: input.githubRunner ?? spawnGithubVerificationRunner,
				cwd: input.repository ?? ".",
				maxWaitMs: input.maxWaitMs,
				clock: input.clock,
				sleep: input.sleep,
				onResult: input.onCiResult,
			});
		} catch (error) {
			uncertainties.push(error instanceof Error ? error.message : String(error));
		}
	}
	const ciFailed = Object.values(ci.checks).some((value) => value === "fail");
	const ciMissing = Object.values(ci.checks).some((value) => value === "missing" || value === "pending");
	let verdict: VerificationVerdict;
	if (!replay.passed || ciFailed) verdict = "fail";
	else if (uncertainties.length > 0 || ciMissing || !ci.allRequiredPassed) verdict = "needs-human";
	else verdict = "pass";
	const finalReplay = uncertainties.length === replay.uncertainties.length ? replay : { ...replay, uncertainties };
	const finalConfidence = confidence(verdict, finalReplay, ci);
	return {
		verdict,
		confidence: finalConfidence,
		ciChecks: ci.checks,
		ciHistory: ci.polls ?? [],
		rationale: verdict === "pass" ? "exact commits replayed successfully" : finalConfidence.rationale,
		uncertainties: finalConfidence.uncertainties,
		replay: finalReplay,
		ci,
		candidateSha: input.manifest.candidateSha,
	};
}

/** Replay runs in the sterile verifier service; this controller-side step may use gh authentication. */
export async function verifyEvidence(input: VerificationInput): Promise<VerificationReport> {
	let replay: ReplayResult;
	try {
		replay = await replayEvidence({
			repository: input.repository,
			manifest: input.manifest,
			runner: input.runner,
			environment: input.environment,
		});
	} catch (error) {
		replay = {
			passed: false,
			clean: false,
			ancestry: false,
			commands: [],
			rationale: error instanceof Error ? error.message : String(error),
			uncertainties: [],
		};
	}
	return verifyReplayAndGithub({
		manifest: input.manifest,
		replay,
		prNumber: input.prNumber,
		requiredChecks: input.requiredChecks,
		githubRunner: input.githubRunner,
		repository: input.repository,
		maxWaitMs: input.maxWaitMs,
		clock: input.clock,
		sleep: input.sleep,
		onCiResult: input.onCiResult,
	});
}

export interface StoredVerification {
	id: string;
	manifestId: string;
	report: VerificationReport;
	createdAt: string;
}

export interface VerificationStore {
	createEvidenceManifest?: (input: { caseId: string; manifest: EvidenceManifest }) => string;
	createVerificationRun?: (input: {
		id?: string;
		manifestId: string;
		report: VerificationReport;
		replayOf?: string;
	}) => string;
}

export async function verifyAndStore(
	input: VerificationInput & { caseId: string; store: VerificationStore },
): Promise<StoredVerification> {
	const report = await verifyEvidence(input);
	if (!input.store.createEvidenceManifest || !input.store.createVerificationRun)
		throw new Error("verification store is incomplete");
	const manifestId = input.store.createEvidenceManifest({ caseId: input.caseId, manifest: input.manifest });
	const id = input.store.createVerificationRun({ manifestId, report });
	return { id, manifestId, report, createdAt: (input.now ?? (() => new Date()))().toISOString() };
}

export { replayEvidence } from "./reproduce.ts";
