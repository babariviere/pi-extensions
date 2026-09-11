import { ExternalEffectExecutor, type EffectReconciliation, type EffectStore } from "./effects.ts";

export interface LinearWorkflowState {
	id: string;
	name: string;
	type: string;
}

export interface LinearIssueSnapshot {
	id: string;
	revision: string;
	teamId?: string;
	teamKey?: string;
	state: LinearWorkflowState;
}

export interface LinearEffectClient {
	getIssue(issueId: string): Promise<LinearIssueSnapshot | null>;
	getStartedStates(team: { id?: string; key?: string }): Promise<LinearWorkflowState[]>;
	updateIssueState(issueId: string, stateId: string): Promise<boolean>;
}

export type LinearWorkPhase = "investigation" | "specification" | "implementation";
export type LinearStartStatus = "started" | "already-started" | "preserved";

export interface LinearStartInput {
	issue: LinearIssueSnapshot;
	phase: LinearWorkPhase;
	owner?: string;
}

export interface LinearStartResult {
	status: LinearStartStatus;
	issueId: string;
	state: LinearWorkflowState;
}

export function linearStartOperationKey(issueId: string, observedRevision: string, phase: LinearWorkPhase): string {
	return `linear:advance:${issueId}:${observedRevision}:${phase}`;
}

function normalized(value: string): string {
	return value.trim().toLowerCase();
}

function isTerminal(state: LinearWorkflowState): boolean {
	const type = normalized(state.type);
	return type === "completed" || type === "canceled" || type === "cancelled";
}

function canAdvance(state: LinearWorkflowState): boolean {
	const type = normalized(state.type);
	return type === "backlog" || type === "unstarted";
}

function isStarted(state: LinearWorkflowState): boolean {
	return normalized(state.type) === "started";
}

/** Narrow, forward-only Linear mutations owned by the background controller. */
export class LinearEffects {
	private readonly executor: ExternalEffectExecutor;

	constructor(
		readonly store: EffectStore,
		readonly client: LinearEffectClient,
		options: { owner: string; leaseMs?: number; now?: () => Date },
	) {
		this.executor = new ExternalEffectExecutor(store, options);
	}

	async startWork(input: LinearStartInput): Promise<LinearStartResult> {
		const observed = input.issue;
		if (!observed.id.trim() || !observed.revision.trim())
			throw new Error("Linear issue id and revision are required");
		const operationKey = linearStartOperationKey(observed.id, observed.revision, input.phase);
		const intent = {
			issueId: observed.id,
			observedRevision: observed.revision,
			observedStateId: observed.state.id,
			observedStateType: observed.state.type,
			teamId: observed.teamId,
			teamKey: observed.teamKey,
			phase: input.phase,
		};

		return this.executor.execute<LinearStartResult>({
			operationKey,
			provider: "linear",
			action: "advance-to-started",
			intent,
			reconcile: async () => this.reconcile(observed),
			perform: async () => this.perform(observed),
			decode: (outcome) => outcome as LinearStartResult,
		});
	}

	private async inspect(
		observed: LinearIssueSnapshot,
	): Promise<
		| { kind: "preserved"; state: LinearWorkflowState }
		| { kind: "already-started"; state: LinearWorkflowState }
		| { kind: "advance"; state: LinearWorkflowState; target: LinearWorkflowState }
	> {
		const current = await this.client.getIssue(observed.id);
		if (!current) return { kind: "preserved", state: observed.state };
		if (current.revision !== observed.revision || current.state.id !== observed.state.id)
			return { kind: "preserved", state: current.state };
		if (isStarted(current.state)) return { kind: "already-started", state: current.state };
		if (isTerminal(current.state) || !canAdvance(current.state)) return { kind: "preserved", state: current.state };
		const states = (await this.client.getStartedStates({ id: current.teamId, key: current.teamKey })).filter(
			isStarted,
		);
		const target = states.find((state) => normalized(state.name) === "in progress") ?? states[0];
		if (!target) return { kind: "preserved", state: current.state };
		return { kind: "advance", state: current.state, target };
	}

	private async reconcile(observed: LinearIssueSnapshot): Promise<EffectReconciliation<LinearStartResult>> {
		const inspected = await this.inspect(observed);
		if (inspected.kind === "advance") return { found: false };
		return {
			found: true,
			value: {
				status: inspected.kind,
				issueId: observed.id,
				state: inspected.state,
			},
		};
	}

	private async perform(observed: LinearIssueSnapshot): Promise<LinearStartResult> {
		const inspected = await this.inspect(observed);
		if (inspected.kind === "already-started" || inspected.kind === "preserved")
			return { status: inspected.kind, issueId: observed.id, state: inspected.state };
		if (!(await this.client.updateIssueState(observed.id, inspected.target.id)))
			throw new Error(`Linear state update failed for ${observed.id}`);
		return { status: "started", issueId: observed.id, state: inspected.target };
	}
}
