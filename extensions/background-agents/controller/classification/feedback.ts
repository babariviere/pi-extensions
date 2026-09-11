import type { BackgroundAgentsDatabase, PolicyInput } from "../database.ts";
import type { ClassificationDisposition, InputKind } from "../../types.ts";

export type FeedbackAction = "reclassify" | "dismiss-noise" | "question-to-bug" | "approve-investigation";

export interface OperatorFeedback {
	caseId: string;
	classificationId?: string;
	action: FeedbackAction;
	actor: string;
	inputKind?: InputKind;
	disposition?: ClassificationDisposition;
	rationale?: string;
}

export interface PolicyRollback {
	scope: string;
	version: string;
	actor: string;
}

export function isExplicitHumanActor(actor: string): boolean {
	return Boolean(actor.trim()) && !/^(agent|system|model|classifier)(:|$)/i.test(actor.trim());
}

function requireHuman(actor: string): string {
	if (!isExplicitHumanActor(actor)) throw new Error("Only an explicit human action is permitted");
	return actor.trim();
}

function correction(input: OperatorFeedback): Record<string, unknown> {
	switch (input.action) {
		case "reclassify":
			if (!input.inputKind && !input.disposition)
				throw new Error("reclassify feedback requires inputKind or disposition");
			return {
				action: input.action,
				...(input.inputKind ? { inputKind: input.inputKind } : {}),
				...(input.disposition ? { disposition: input.disposition } : {}),
				...(input.rationale ? { rationale: input.rationale } : {}),
			};
		case "dismiss-noise":
			return {
				action: input.action,
				disposition: "noise",
				...(input.rationale ? { rationale: input.rationale } : {}),
			};
		case "question-to-bug":
			return {
				action: input.action,
				inputKind: "bug-report",
				disposition: "actionable",
				...(input.rationale ? { rationale: input.rationale } : {}),
			};
		case "approve-investigation":
			return { action: input.action, approved: true, ...(input.rationale ? { rationale: input.rationale } : {}) };
	}
}

/** Record an operator correction as an approved classifier example without copying source payloads. */
export function recordOperatorFeedback(database: BackgroundAgentsDatabase, input: OperatorFeedback): string {
	return database.recordFeedback({
		caseId: input.caseId,
		classificationId: input.classificationId,
		correction: correction(input),
		actor: requireHuman(input.actor),
	});
}

/** Agent proposals are durable, but remain inactive until a human activates them. */
export function proposePolicyRevision(database: BackgroundAgentsDatabase, input: PolicyInput): string {
	return database.createPolicy(input);
}

export function activatePolicyRevision(database: BackgroundAgentsDatabase, policyId: string, actor: string): void {
	database.activatePolicy(policyId, requireHuman(actor));
}

export function rollbackPolicy(database: BackgroundAgentsDatabase, input: PolicyRollback): void {
	const policy = database.getPolicy(input.scope, input.version);
	if (!policy) throw new Error(`Unknown classifier policy: ${input.scope}@${input.version}`);
	database.activatePolicy(policy.id, requireHuman(input.actor));
}

export const recordFeedback = recordOperatorFeedback;
export const proposePolicy = proposePolicyRevision;
export const activatePolicy = activatePolicyRevision;
