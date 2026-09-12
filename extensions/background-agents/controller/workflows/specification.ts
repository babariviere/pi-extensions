import { createHash } from "node:crypto";
import type { BackgroundAgentsDatabase, StoredSpecificationVersion } from "../database.ts";
import { BackgroundAgentsStateMachine, type ApprovalResult } from "../state-machine.ts";
import type { SpecificationWorkItem } from "../../types.ts";

export interface SpecificationDraft {
	specification: unknown;
	decisions: unknown[];
	unresolvedQuestions: unknown[];
	permissions: string[];
	plannerSummary: string;
	decomposition: SpecificationWorkItem[];
}

export interface PlannerContext {
	mode: "specification";
	caseId: string;
	latest?: StoredSpecificationVersion;
	decisions: unknown[];
	unresolvedQuestions: unknown[];
	previousPlannerSummary?: string;
	feedback: Array<{ id: string; specVersion: number; feedback: string; actor: string; createdAt: string }>;
	capabilities: { tools: string[]; mutations: false; externalResponses: false };
}

export interface SpecificationFeedbackResult {
	feedbackId: string;
	jobId: string;
	attemptId: string;
	context: PlannerContext;
}

export function validateSpecificationDecomposition(value: unknown): SpecificationWorkItem[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("decomposition must be a non-empty array");
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item))
			throw new Error(`decomposition item ${index + 1} must be an object`);
		const record = item as Record<string, unknown>;
		const fields = Object.keys(record).sort();
		if (fields.join(",") !== "acceptanceCriteria,order,scope,title")
			throw new Error(`decomposition item ${index + 1} has an invalid shape`);
		if (record.order !== index + 1) throw new Error("decomposition order must be contiguous and explicit");
		if (typeof record.title !== "string" || !record.title.trim())
			throw new Error(`decomposition item ${index + 1} title must be non-empty`);
		if (typeof record.scope !== "string" || !record.scope.trim())
			throw new Error(`decomposition item ${index + 1} scope must be non-empty`);
		if (
			!Array.isArray(record.acceptanceCriteria) ||
			record.acceptanceCriteria.length === 0 ||
			record.acceptanceCriteria.some((criterion) => typeof criterion !== "string" || !criterion.trim())
		)
			throw new Error(`decomposition item ${index + 1} acceptanceCriteria must be non-empty strings`);
		return {
			order: index + 1,
			title: record.title.trim(),
			scope: record.scope.trim(),
			acceptanceCriteria: (record.acceptanceCriteria as string[]).map((criterion) => criterion.trim()),
		};
	});
}

function canonical(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	throw new Error(`Unsupported specification material: ${typeof value}`);
}

/** Hash all approval-relevant material, including permissions and unresolved decisions. */
export function specificationMaterialHash(draft: SpecificationDraft): string {
	return createHash("sha256")
		.update(
			canonical({
				specification: draft.specification,
				decisions: draft.decisions,
				unresolvedQuestions: draft.unresolvedQuestions,
				permissions: draft.permissions,
				plannerSummary: draft.plannerSummary,
				decomposition: draft.decomposition,
			}),
		)
		.digest("hex");
}

function plannerContext(database: BackgroundAgentsDatabase, caseId: string): PlannerContext {
	const latest = database.getLatestSpecification(caseId);
	const feedback = database
		.all<Record<string, unknown>>(
			"SELECT id, spec_version, feedback, actor, created_at FROM specification_feedback WHERE case_id = ? ORDER BY created_at ASC, id ASC",
			caseId,
		)
		.map((row) => ({
			id: String(row.id),
			specVersion: Number(row.spec_version),
			feedback: String(row.feedback),
			actor: String(row.actor),
			createdAt: String(row.created_at),
		}));
	return {
		mode: "specification",
		caseId,
		latest,
		decisions: latest?.decisions ?? [],
		unresolvedQuestions: latest?.unresolvedQuestions ?? [],
		...(latest?.plannerSummary === undefined ? {} : { previousPlannerSummary: latest.plannerSummary }),
		feedback,
		capabilities: { tools: ["read", "grep", "find", "ls"], mutations: false, externalResponses: false },
	};
}

export class SpecificationWorkflow {
	private readonly stateMachine: BackgroundAgentsStateMachine;

	constructor(private readonly database: BackgroundAgentsDatabase) {
		this.stateMachine = new BackgroundAgentsStateMachine(database);
	}

	start(caseId: string, priority = 0): { jobId: string; attemptId: string; context: PlannerContext } {
		const state = this.database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", caseId)?.state;
		if (!state) throw new Error(`Unknown case: ${caseId}`);
		if (state === "investigating" || state === "classified" || state === "retry")
			this.database.transitionCase(caseId, "specification", "workflow", "specification planning started");
		else if (state !== "specification") throw new Error(`Case ${caseId} cannot start specification from ${state}`);
		const attempt = this.database.createFreshPlannerAttempt({ caseId, priority });
		return { ...attempt, context: plannerContext(this.database, caseId) };
	}

	recordPlannerResult(caseId: string, draft: SpecificationDraft): StoredSpecificationVersion {
		const state = this.database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", caseId)?.state;
		if (state !== "investigating" && state !== "classified" && state !== "retry" && state !== "specification")
			throw new Error(`Case ${caseId} cannot record a specification from ${state ?? "unknown"}`);
		if (!draft.plannerSummary.trim()) throw new Error("plannerSummary must be non-empty");
		const decomposition = validateSpecificationDecomposition(draft.decomposition);
		const materialHash = specificationMaterialHash({ ...draft, decomposition });
		const version = this.database.createSpecificationVersion({ ...draft, decomposition, caseId, materialHash });
		if (state === "investigating" || state === "classified" || state === "retry") {
			this.database.transitionCase(caseId, "specification", "spec-planner", "specification recorded");
			this.database.transitionCase(caseId, "specification", "spec-planner", "specification awaiting approval", {
				version: version.version,
			});
		} else if (state === "specification") {
			this.database.transitionCase(caseId, "awaiting-approval", "spec-planner", "specification awaiting approval", {
				version: version.version,
			});
		} else {
			throw new Error(`Case ${caseId} cannot record a specification from ${state ?? "unknown"}`);
		}
		return version;
	}

	recordHumanFeedback(
		caseId: string,
		specVersion: number,
		feedback: string,
		actor: string,
	): SpecificationFeedbackResult {
		const state = this.database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", caseId)?.state;
		if (state !== "awaiting-approval" && state !== "specification")
			throw new Error(`Case ${caseId} cannot accept specification feedback from ${state ?? "unknown"}`);
		const latest = this.database.getLatestSpecification(caseId);
		if (!latest || latest.version !== specVersion)
			throw new Error(`Specification version ${specVersion} is not current`);
		if (!feedback.trim()) throw new Error("feedback must be non-empty");
		if (!actor.trim()) throw new Error("actor must be non-empty");
		if (/^(agent|system|model|classifier)(:|$)/i.test(actor.trim()))
			throw new Error("Specification feedback requires an explicit human actor");
		if (state === "awaiting-approval")
			this.database.transitionCase(caseId, "specification", actor, "human specification feedback received");
		const result = this.database.recordSpecificationFeedback({ caseId, specVersion, feedback, actor });
		return { ...result, context: plannerContext(this.database, caseId) };
	}

	approve(
		caseId: string,
		specVersion: number,
		permissions: string[],
		actor: string,
		orderedWorkItems?: string[],
	): ApprovalResult {
		const latest = this.database.getLatestSpecification(caseId);
		if (!latest || latest.version !== specVersion)
			throw new Error(`Specification version ${specVersion} is not current`);
		const options = {
			materialHash: latest.materialHash,
			orderedWorkItems: orderedWorkItems ?? latest.orderedWorkItems,
		};
		const result = this.stateMachine.approveSpecification(caseId, specVersion, permissions, actor, options);
		this.queueNextWorker(caseId);
		return result;
	}

	/** Queue exactly the next approved item after every earlier item is verified. */
	queueNextWorker(caseId: string): string | undefined {
		const approval = this.database.get<{ ordered_work_items: string | null }>(
			"SELECT a.ordered_work_items FROM approvals a JOIN spec_versions s ON s.id = a.spec_version_id WHERE s.case_id = ? AND a.decision = 'approved' ORDER BY a.created_at DESC, a.id DESC LIMIT 1",
			caseId,
		);
		if (!approval?.ordered_work_items) return undefined;
		let ordered: string[];
		try {
			const value: unknown = JSON.parse(approval.ordered_work_items);
			if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
			ordered = value;
		} catch {
			return undefined;
		}
		for (let index = 0; index < ordered.length; index += 1) {
			const workItemId = ordered[index];
			const item = this.database.get<{ state: string; parent_id: string | null }>(
				"SELECT state, parent_id FROM work_items WHERE id = ?",
				workItemId,
			);
			if (!item || item.state !== "queued") continue;
			if (index === 0 ? item.parent_id !== null : item.parent_id !== ordered[index - 1]) return undefined;
			const previous = ordered
				.slice(0, index)
				.map((id) => this.database.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", id)?.state);
			if (previous.some((state) => state !== "verified")) return undefined;
			if (
				this.database.get(
					"SELECT id FROM jobs WHERE case_id = ? AND work_item_id = ? AND role = 'worker'",
					caseId,
					workItemId,
				)
			)
				continue;
			return this.database.createJob({ caseId, workItemId, role: "worker" });
		}
		return undefined;
	}

	context(caseId: string): PlannerContext {
		return plannerContext(this.database, caseId);
	}
}

export const createSpecificationWorkflow = (database: BackgroundAgentsDatabase): SpecificationWorkflow =>
	new SpecificationWorkflow(database);
