import type { Confidence, EvidenceManifest, VerificationRun, VerificationVerdict } from "../../types.ts";
import { checkRequiredCi, pullRequestIdentity, type CiVerification } from "./ci.ts";
import { replayEvidence, spawnReplayRunner, type ReplayProcessRunner, type ReplayResult } from "./reproduce.ts";

export interface VerificationInput {
	manifest: EvidenceManifest;
	repository: string;
	prNumber?: number;
	requiredChecks?: readonly string[];
	runner?: ReplayProcessRunner;
	environment?: NodeJS.ProcessEnv;
	now?: () => Date;
}

export interface VerificationReport extends Omit<VerificationRun, "id" | "manifestId" | "version" | "createdAt"> {
	replay: ReplayResult;
	ci: CiVerification;
	candidateSha: string;
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
	const requiredChecks = [...(input.requiredChecks ?? [])];
	let ci: CiVerification = {
		checks: {},
		results: [],
		allRequiredPassed: requiredChecks.length === 0,
		missing: [],
		uncertainties: [],
	};
	const uncertainties = [...replay.uncertainties];
	if (input.prNumber !== undefined) {
		try {
			const identity = await pullRequestIdentity(
				input.prNumber,
				input.runner ?? spawnReplayRunner,
				input.repository,
			);
			if (identity.headSha !== input.manifest.candidateSha.toLowerCase())
				uncertainties.push("pull request head SHA does not match candidate");
			if (uncertainties.length === 0) {
				ci = await checkRequiredCi(
					input.prNumber,
					requiredChecks,
					input.runner ?? spawnReplayRunner,
					input.repository,
				);
			}
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
		rationale: verdict === "pass" ? "exact commits replayed successfully" : finalConfidence.rationale,
		uncertainties: finalConfidence.uncertainties,
		replay: finalReplay,
		ci,
		candidateSha: input.manifest.candidateSha,
	};
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
