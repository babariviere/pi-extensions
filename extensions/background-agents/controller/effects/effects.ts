import type { EffectInput, EffectClaim, StoredEffect } from "../database.ts";

export interface EffectStore {
	ensureEffect(input: EffectInput): string;
	getEffect(operationKey: string): StoredEffect | undefined;
	claimEffect(operationKey: string, owner: string, leaseMs?: number, now?: Date): EffectClaim | null;
	completeEffect(operationKey: string, owner: string, outcome?: unknown, remoteIdentifier?: string): void;
	markEffectUnknown(operationKey: string, owner: string, outcome: unknown): void;
	isEmergencyStop?(): boolean;
	getEmergencyStopEpoch?(): number;
	getReadyVerification?: (
		manifestId: string,
		verificationRunId: string,
	) => { id: string; baseSha: string; candidateSha: string; ciChecks: Record<string, string> } | undefined;
}

export interface ExternalMutationControls {
	isStopped(): boolean;
}

export interface EffectReconciliation<T> {
	found: boolean;
	value?: T;
	remoteIdentifier?: string;
}

export interface EffectOperation<T> extends EffectInput {
	reconcile: (effect: StoredEffect) => Promise<EffectReconciliation<T>>;
	perform: () => Promise<T>;
	remoteIdentifier?: (value: T) => string | undefined;
	decode?: (outcome: unknown) => T;
}

export interface EffectExecutorOptions {
	owner: string;
	leaseMs?: number;
	now?: () => Date;
	controls?: ExternalMutationControls;
	expectedStopEpoch?: number;
}

function errorOutcome(error: unknown): { error: string } {
	return { error: error instanceof Error ? error.message : String(error) };
}

/** Executes controller-owned mutations with a durable intent and an expiring claim. */
export class ExternalEffectExecutor {
	private readonly now: () => Date;

	constructor(
		readonly store: EffectStore,
		readonly options: EffectExecutorOptions,
	) {
		if (!options.owner.trim()) throw new Error("effect owner must be non-empty");
		this.now = options.now ?? (() => new Date());
	}

	async execute<T>(operation: EffectOperation<T>): Promise<T> {
		this.store.ensureEffect(operation);
		const beforeClaim = this.store.getEffect(operation.operationKey);
		if (!beforeClaim) throw new Error("Effect intent disappeared: " + operation.operationKey);
		if (beforeClaim.reconciliationState === "succeeded") return this.decode(operation, beforeClaim.outcome);

		const claim = this.store.claimEffect(
			operation.operationKey,
			this.options.owner,
			this.options.leaseMs,
			this.now(),
		);
		if (!claim) {
			const current = this.store.getEffect(operation.operationKey);
			if (current?.reconciliationState === "succeeded") return this.decode(operation, current.outcome);
			throw new Error("Effect is currently claimed: " + operation.operationKey);
		}

		try {
			if (beforeClaim.reconciliationState === "unknown") {
				const reconciled = await operation.reconcile(beforeClaim);
				if (reconciled.found) {
					this.store.completeEffect(
						operation.operationKey,
						this.options.owner,
						reconciled.value ?? {},
						reconciled.remoteIdentifier ?? operation.remoteIdentifier?.(reconciled.value as T),
					);
					return reconciled.value as T;
				}
			}

			if (
				this.options.expectedStopEpoch !== undefined &&
				this.store.getEmergencyStopEpoch?.() !== this.options.expectedStopEpoch
			)
				throw new Error("effect was invalidated by emergency stop");
			if (this.stopped()) throw new Error("external mutations are disabled by emergency stop");
			const value = await operation.perform();
			if (
				this.options.expectedStopEpoch !== undefined &&
				this.store.getEmergencyStopEpoch?.() !== this.options.expectedStopEpoch
			)
				throw new Error("effect was invalidated by emergency stop");
			this.store.completeEffect(
				operation.operationKey,
				this.options.owner,
				value,
				operation.remoteIdentifier?.(value),
			);
			return value;
		} catch (error) {
			try {
				this.store.markEffectUnknown(operation.operationKey, this.options.owner, errorOutcome(error));
			} catch {
				// A lost claim is still an uncertain external outcome. Preserve the original error.
			}
			throw error;
		}
	}

	private stopped(): boolean {
		return this.options.controls?.isStopped() ?? this.store.isEmergencyStop?.() ?? false;
	}

	private decode<T>(operation: EffectOperation<T>, outcome: unknown): T {
		return operation.decode ? operation.decode(outcome) : (outcome as T);
	}
}
