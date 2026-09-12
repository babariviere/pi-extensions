import type { BackgroundAgentsDatabase } from "../database.ts";
import { buildInvestigationContext, type InvestigationContext } from "./investigation.ts";

export const QUESTION_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface QuestionLimits {
	maxTimeMs: number;
	maxCostUsd: number;
	maxResults: number;
}

export interface QuestionContext extends Omit<InvestigationContext, "mode" | "capabilities"> {
	mode: "question-analysis";
	question: string;
	limits: QuestionLimits;
	capabilities: { tools: readonly string[]; mutations: false; externalResponses: false };
}

export interface PrivateQuestionBrief {
	findings: unknown;
	sources: unknown[];
	confidence: number;
	uncertainties: string[];
}

export const DEFAULT_QUESTION_LIMITS: QuestionLimits = {
	maxTimeMs: 60_000,
	maxCostUsd: 0,
	maxResults: 10,
};

function validLimits(limits: QuestionLimits): QuestionLimits {
	if (!Number.isSafeInteger(limits.maxTimeMs) || limits.maxTimeMs <= 0) throw new Error("maxTimeMs must be positive");
	if (!Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd < 0) throw new Error("maxCostUsd must be non-negative");
	if (!Number.isSafeInteger(limits.maxResults) || limits.maxResults <= 0)
		throw new Error("maxResults must be positive");
	return { ...limits, maxResults: Math.min(limits.maxResults, 50) };
}

function assertReadOnlyTools(tools: readonly string[]): void {
	const allowed = new Set<string>(QUESTION_READ_ONLY_TOOLS);
	if (tools.some((tool) => !allowed.has(tool))) throw new Error("question analysis permits read-only tools only");
}

/** Question analysis has no response or mutation operation in its contract. */
export function buildQuestionContext(
	database: BackgroundAgentsDatabase,
	caseId: string,
	question: string,
	limits: QuestionLimits,
	tools: readonly string[] = QUESTION_READ_ONLY_TOOLS,
): QuestionContext {
	if (!question.trim()) throw new Error("question must be non-empty");
	assertReadOnlyTools(tools);
	const boundedLimits = validLimits(limits);
	const investigation = buildInvestigationContext(database, caseId, boundedLimits.maxResults);
	return {
		...investigation,
		mode: "question-analysis",
		question: question.trim(),
		limits: boundedLimits,
		capabilities: { tools: [...tools], mutations: false, externalResponses: false },
	};
}

export class QuestionWorkflow {
	constructor(private readonly database: BackgroundAgentsDatabase) {}

	start(caseId: string, question: string, limits: QuestionLimits): { jobId: string; context: QuestionContext } {
		const state = this.database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", caseId)?.state;
		if (!state) throw new Error(`Unknown case: ${caseId}`);
		// Validate the bounded request before changing durable case state.
		buildQuestionContext(this.database, caseId, question, limits);
		if (state === "classified")
			this.database.transitionCase(caseId, "question-analysis", "workflow", "question analysis started");
		else if (state !== "question-analysis")
			throw new Error(`Case ${caseId} cannot start question analysis from ${state}`);
		const existing = this.database.get<{ id: string }>(
			"SELECT id FROM jobs WHERE case_id = ? AND role = 'investigator' AND state IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
			caseId,
		);
		const jobId = existing?.id ?? this.database.createJob({ caseId, role: "investigator" });
		return { jobId, context: buildQuestionContext(this.database, caseId, question, limits) };
	}

	record(
		caseId: string,
		question: string,
		brief: PrivateQuestionBrief,
		limits: QuestionLimits,
		attemptId?: string,
	): string {
		const state = this.database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", caseId)?.state;
		if (!state) throw new Error(`Unknown case: ${caseId}`);
		if (state !== "question-analysis") throw new Error(`Case ${caseId} cannot record a question brief from ${state}`);
		const normalizedQuestion = question.trim();
		if (!normalizedQuestion) throw new Error("question must be non-empty");
		const boundedLimits = validLimits(limits);
		if (!Number.isFinite(brief.confidence) || brief.confidence < 0 || brief.confidence > 100)
			throw new Error("confidence must be between 0 and 100");
		const briefId = this.database.createQuestionBrief({
			caseId,
			attemptId,
			question: normalizedQuestion,
			findings: brief.findings,
			sources: brief.sources,
			confidence: brief.confidence,
			uncertainties: brief.uncertainties,
			limits: boundedLimits,
		});
		this.database.transitionCase(caseId, "handled", "workflow", "private question brief recorded");
		return briefId;
	}
}

export const createQuestionWorkflow = (database: BackgroundAgentsDatabase): QuestionWorkflow =>
	new QuestionWorkflow(database);
