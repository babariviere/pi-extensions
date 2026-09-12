import { randomUUID } from "node:crypto";
import type { BackgroundAgentsDatabase } from "./database.ts";
import { jsonBoundary } from "./database.ts";
import type { CaseState } from "../types.ts";

export type WorkItemState = "queued" | "implementation" | "verification" | "verified" | "blocked" | "cancelled";

export const CASE_TRANSITIONS: Readonly<Record<CaseState, readonly CaseState[]>> = {
	intake: ["classified", "blocked", "cancelled"],
	classified: ["investigating", "question-analysis", "specification", "blocked", "paused", "cancelled"],
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

export const WORK_ITEM_TRANSITIONS: Readonly<Record<WorkItemState, readonly WorkItemState[]>> = {
	queued: ["implementation", "cancelled"],
	implementation: ["verification", "blocked", "cancelled"],
	verification: ["verified", "blocked", "cancelled"],
	verified: [],
	blocked: ["queued", "cancelled"],
	cancelled: [],
};

export class IllegalWorkItemTransitionError extends Error {
	constructor(workItemId: string, from: WorkItemState, to: WorkItemState) {
		super(`Illegal work-item transition for ${workItemId}: ${from} -> ${to}`);
		this.name = "IllegalWorkItemTransitionError";
	}
}

export class SpecificationVersionMismatchError extends Error {
	constructor(caseId: string, requested: number, current: number | undefined) {
		super(
			current === undefined
				? `Unknown specification version for ${caseId}: ${requested}`
				: `Specification approval for ${caseId} is stale: requested ${requested}, current ${current}`,
		);
		this.name = "SpecificationVersionMismatchError";
	}
}

export class SpecificationMaterialMismatchError extends Error {
	constructor(caseId: string) {
		super(`Specification approval material is stale for ${caseId}`);
		this.name = "SpecificationMaterialMismatchError";
	}
}

export interface WorkItemInput {
	id?: string;
	caseId: string;
	ordinal: number;
	parentId?: string;
	title: string;
	branch?: string;
	worktree?: string;
}

export interface ApprovalResult {
	approvalId: string;
	specVersion: number;
}

export interface SpecificationApprovalOptions {
	materialHash?: string;
	orderedWorkItems?: string[];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function nonEmpty(value: string, field: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
	return value.trim();
}

function workItemState(value: unknown): WorkItemState {
	if (typeof value !== "string" || !(value in WORK_ITEM_TRANSITIONS))
		throw new Error(`work item state is invalid: ${value}`);
	return value as WorkItemState;
}

export function canTransitionCase(from: CaseState, to: CaseState): boolean {
	return CASE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionWorkItem(from: WorkItemState, to: WorkItemState): boolean {
	return WORK_ITEM_TRANSITIONS[from]?.includes(to) ?? false;
}

export class BackgroundAgentsStateMachine {
	constructor(private readonly database: BackgroundAgentsDatabase) {}

	transitionCase(caseId: string, to: CaseState, actor: string, reason?: string, metadata: unknown = {}): void {
		this.database.transitionCase(nonEmpty(caseId, "caseId"), to, nonEmpty(actor, "actor"), reason, metadata);
	}

	createWorkItem(input: WorkItemInput): string {
		const id = input.id ? nonEmpty(input.id, "id") : randomUUID();
		if (!Number.isSafeInteger(input.ordinal) || input.ordinal <= 0)
			throw new Error("ordinal must be a positive integer");
		const caseId = nonEmpty(input.caseId, "caseId");
		const title = nonEmpty(input.title, "title");
		const existingCase = this.database.get<{ id: string }>("SELECT id FROM cases WHERE id = ?", caseId);
		if (!existingCase) throw new Error(`Unknown case: ${caseId}`);
		if (input.parentId) {
			const parent = this.database.get<{ case_id: string }>(
				"SELECT case_id FROM work_items WHERE id = ?",
				input.parentId,
			);
			if (!parent) throw new Error(`Unknown parent work item: ${input.parentId}`);
			if (parent.case_id !== caseId) throw new Error("parent work item belongs to another case");
		}
		this.database.run(
			"INSERT INTO work_items (id, case_id, ordinal, parent_id, title, branch, worktree) VALUES (?, ?, ?, ?, ?, ?, ?)",
			id,
			caseId,
			input.ordinal,
			input.parentId ?? null,
			title,
			input.branch ?? null,
			input.worktree ?? null,
		);
		return id;
	}

	transitionWorkItem(workItemId: string, to: WorkItemState, actor: string, reason?: string): void {
		const id = nonEmpty(workItemId, "workItemId");
		nonEmpty(actor, "actor");
		const current = this.database.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", id);
		if (!current) throw new Error(`Unknown work item: ${id}`);
		const from = workItemState(current.state);
		if (!canTransitionWorkItem(from, to)) throw new IllegalWorkItemTransitionError(id, from, to);
		const result = this.database.run(
			"UPDATE work_items SET state = ?, updated_at = ? WHERE id = ? AND state = ?",
			to,
			new Date().toISOString(),
			id,
			from,
		);
		if (result.changes !== 1) throw new Error(`Work item changed concurrently: ${id}`);
		void reason;
	}

	pauseCase(caseId: string, actor: string, reason?: string, usage = false): CaseState {
		const id = nonEmpty(caseId, "caseId");
		const current = this.database.get<{ state: CaseState }>("SELECT state FROM cases WHERE id = ?", id);
		if (!current) throw new Error(`Unknown case: ${id}`);
		const target: CaseState = usage ? "paused-usage" : "paused";
		if (!canTransitionCase(current.state, target)) {
			throw new Error(`Cannot pause case ${id} from ${current.state}`);
		}
		this.transitionCase(id, target, actor, reason ?? (usage ? "provider usage unavailable" : "paused"));
		return target;
	}

	resumeCase(caseId: string, actor: string, reason?: string, target?: CaseState): CaseState {
		const id = nonEmpty(caseId, "caseId");
		const current = this.database.get<{ state: CaseState }>("SELECT state FROM cases WHERE id = ?", id);
		if (!current) throw new Error(`Unknown case: ${id}`);
		if (current.state !== "paused" && current.state !== "paused-usage" && current.state !== "retry") {
			throw new Error(`Case ${id} is not resumable from ${current.state}`);
		}
		const previous = this.database.get<{ from_state: CaseState }>(
			"SELECT from_state FROM case_events WHERE case_id = ? AND to_state = ? ORDER BY created_at DESC, id DESC LIMIT 1",
			id,
			current.state,
		);
		const next = target ?? previous?.from_state;
		if (!next) throw new Error(`Case ${id} has no resume checkpoint`);
		if (!canTransitionCase(current.state, next)) throw new Error(`Cannot resume case ${id} to ${next}`);
		this.transitionCase(id, next, actor, reason ?? "resumed");
		return next;
	}

	retryCase(caseId: string, actor: string, reason?: string): void {
		this.transitionCase(caseId, "retry", actor, reason ?? "retry requested");
	}

	cancelCase(caseId: string, actor: string, reason?: string): void {
		this.transitionCase(caseId, "cancelled", actor, reason ?? "cancelled");
	}

	approveSpecification(
		caseId: string,
		specVersion: number,
		permissions: string[],
		actor: string,
		options: SpecificationApprovalOptions = {},
	): ApprovalResult {
		return this.decideSpecification(
			caseId,
			specVersion,
			"approved",
			permissions,
			actor,
			"specification approved",
			"implementation",
			options,
		);
	}

	rejectSpecification(caseId: string, specVersion: number, actor: string): ApprovalResult {
		return this.decideSpecification(
			caseId,
			specVersion,
			"rejected",
			[],
			actor,
			"specification rejected",
			"cancelled",
		);
	}

	requestSpecificationChanges(caseId: string, specVersion: number, feedback: string, actor: string): ApprovalResult {
		return this.decideSpecification(
			caseId,
			specVersion,
			"changes-requested",
			[],
			actor,
			`specification changes requested: ${nonEmpty(feedback, "feedback")}`,
			"specification",
		);
	}

	private decideSpecification(
		caseId: string,
		specVersion: number,
		decision: "approved" | "changes-requested" | "rejected",
		permissions: string[],
		actor: string,
		reason: string,
		nextState: CaseState = "implementation",
		options: SpecificationApprovalOptions = {},
	): ApprovalResult {
		const id = nonEmpty(caseId, "caseId");
		if (!Number.isSafeInteger(specVersion) || specVersion <= 0)
			throw new Error("specVersion must be a positive integer");
		const state = this.database.get<{ state: CaseState }>("SELECT state FROM cases WHERE id = ?", id);
		if (!state) throw new Error(`Unknown case: ${id}`);
		if (state.state !== "awaiting-approval") throw new Error(`Case ${id} is not awaiting specification approval`);
		const latest = this.database.get<{
			id: string;
			version: number;
			ordered_work_items: string;
			decomposition: string;
		}>(
			"SELECT id, version, ordered_work_items, decomposition FROM spec_versions WHERE case_id = ? ORDER BY version DESC LIMIT 1",
			id,
		);
		if (!latest || latest.version !== specVersion) {
			throw new SpecificationVersionMismatchError(id, specVersion, latest?.version);
		}
		if (!permissions.every((permission) => typeof permission === "string" && permission.trim() !== ""))
			throw new Error("permissions must contain non-empty strings");
		const materialHash =
			options.materialHash ??
			this.database.get<{ material_hash: string }>("SELECT material_hash FROM spec_versions WHERE id = ?", latest.id)
				?.material_hash;
		if (!materialHash || (options.materialHash !== undefined && options.materialHash !== materialHash))
			throw new SpecificationMaterialMismatchError(id);
		let orderedWorkItems: string[] = [];
		if (decision === "approved") {
			if (!options.orderedWorkItems) throw new Error("orderedWorkItems are required for specification approval");
			let storedOrder: unknown;
			try {
				storedOrder = JSON.parse(latest.ordered_work_items);
			} catch {
				throw new Error("stored specification decomposition order is invalid");
			}
			if (
				!Array.isArray(storedOrder) ||
				storedOrder.length === 0 ||
				storedOrder.some((item) => typeof item !== "string") ||
				!sameStrings(options.orderedWorkItems, storedOrder)
			)
				throw new Error("orderedWorkItems do not match the current specification decomposition");
			orderedWorkItems = options.orderedWorkItems;
			let decomposition: unknown;
			try {
				decomposition = JSON.parse(latest.decomposition);
			} catch {
				throw new Error("stored specification decomposition is invalid");
			}
			if (!Array.isArray(decomposition) || decomposition.length !== orderedWorkItems.length)
				throw new Error("specification decomposition is empty or mismatched");
			for (let index = 0; index < orderedWorkItems.length; index += 1) {
				const item = this.database.get<{
					case_id: string;
					spec_version_id: string | null;
					ordinal: number;
					parent_id: string | null;
					state: string;
				}>(
					"SELECT case_id, spec_version_id, ordinal, parent_id, state FROM work_items WHERE id = ?",
					orderedWorkItems[index],
				);
				if (
					!item ||
					item.case_id !== id ||
					item.spec_version_id !== latest.id ||
					(index === 0 ? item.parent_id !== null : item.parent_id !== orderedWorkItems[index - 1])
				)
					throw new Error("orderedWorkItems do not form the current linear decomposition");
			}
		} else {
			orderedWorkItems = options.orderedWorkItems ?? [];
		}
		const approvalId = this.database.recordSpecificationApproval({
			caseId: id,
			specVersion,
			materialHash,
			permissions,
			orderedWorkItems,
			decision,
			actor: nonEmpty(actor, "actor"),
		});
		this.transitionCase(id, nextState, actor, reason, { specVersion, permissions });
		return { approvalId, specVersion };
	}
}

export function createStateMachine(database: BackgroundAgentsDatabase): BackgroundAgentsStateMachine {
	return new BackgroundAgentsStateMachine(database);
}
