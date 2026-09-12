import { createHash } from "node:crypto";
import type { BackgroundAgentsDatabase, StoredPolicy } from "../database.ts";
import type {
	ClassifierExample,
	ClassifierOutput,
	Classification,
	ClassificationDisposition,
	RelatedCase,
	SourceEvent,
	ThresholdConfig,
} from "../../types.ts";
import { approvedClassifierExamples, retrieveRelatedCases, type RelatedCaseQuery } from "./memory.ts";

export const CLASSIFIER_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["inputKind", "actionability", "noise", "confidence", "rationale"],
	properties: {
		inputKind: { enum: ["error", "bug-report", "feature", "question", "maintenance", "other", "unknown"] },
		actionability: { type: "number", minimum: 0, maximum: 100 },
		noise: { type: "number", minimum: 0, maximum: 100 },
		confidence: { type: "number", minimum: 0, maximum: 100 },
		rationale: { type: "string", minLength: 1 },
	},
} as const;

export const CLASSIFIER_LAUNCH_CONTRACT = {
	role: "classifier",
	tools: [],
	structuredOutput: true,
	outputSchema: CLASSIFIER_OUTPUT_SCHEMA,
} as const;

export interface ClassifierLaunchRequest {
	readonly role: "classifier";
	readonly tools: readonly [];
	readonly structuredOutput: true;
	readonly outputSchema: typeof CLASSIFIER_OUTPUT_SCHEMA;
	readonly event: SourceEvent;
	readonly policyVersion: string;
	readonly policy: unknown;
	readonly thresholds: ThresholdConfig;
	readonly examples: readonly ClassifierExample[];
	readonly relatedCases: readonly RelatedCase[];
}

export type ClassifierLauncher = (request: ClassifierLaunchRequest) => Promise<unknown>;

export interface ClassifierOptions {
	database: BackgroundAgentsDatabase;
	launch: ClassifierLauncher;
	modelVersion: string;
	thresholds?: ThresholdConfig;
	policyScope?: string;
	exampleLimit?: number;
	relatedCaseLimit?: number;
	isAuthorized?: () => boolean;
}

export interface ClassificationResult {
	classificationId: string;
	classification: Classification;
	relatedCases: RelatedCase[];
	request: ClassifierLaunchRequest;
}

const INPUT_KINDS = new Set(["error", "bug-report", "feature", "question", "maintenance", "other", "unknown"]);

function numberScore(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)
		throw new Error(`${field} must be a number between 0 and 100`);
	return value;
}

function requiredText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
	return value.trim();
}

function output(value: unknown): ClassifierOutput {
	let parsed: unknown = value;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed);
		} catch (error) {
			throw new Error("Classifier returned invalid structured output", { cause: error });
		}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Classifier returned invalid structured output");
	const record = parsed as Record<string, unknown>;
	if (typeof record.inputKind !== "string" || !INPUT_KINDS.has(record.inputKind))
		throw new Error("Classifier output inputKind is invalid");
	return {
		inputKind: record.inputKind as ClassifierOutput["inputKind"],
		actionability: numberScore(record.actionability, "actionability"),
		noise: numberScore(record.noise, "noise"),
		confidence: numberScore(record.confidence, "confidence"),
		rationale: requiredText(record.rationale, "rationale"),
	};
}

function validThresholds(thresholds: ThresholdConfig): ThresholdConfig {
	if (
		!Number.isFinite(thresholds.actionableMin) ||
		!Number.isFinite(thresholds.noiseMax) ||
		thresholds.actionableMin < 0 ||
		thresholds.actionableMin > 100 ||
		thresholds.noiseMax < 0 ||
		thresholds.noiseMax > 100 ||
		thresholds.noiseMax >= thresholds.actionableMin
	)
		throw new Error("noiseMax must be below actionableMin and both thresholds must be 0..100");
	return thresholds;
}

/** Apply deterministic admission thresholds instead of trusting a model disposition. */
export function applyThresholds(outputValue: ClassifierOutput, thresholds: ThresholdConfig): ClassificationDisposition {
	const selected = validThresholds(thresholds);
	if (outputValue.inputKind === "question") return "ambiguous";
	if (
		outputValue.confidence >= selected.actionableMin &&
		outputValue.actionability >= selected.actionableMin &&
		outputValue.noise <= selected.noiseMax
	)
		return "actionable";
	if (
		outputValue.confidence >= selected.actionableMin &&
		outputValue.noise >= selected.actionableMin &&
		outputValue.actionability <= selected.noiseMax
	)
		return "noise";
	return "ambiguous";
}

function policyRecord(policy: StoredPolicy | undefined): Record<string, unknown> {
	if (!policy?.policy || typeof policy.policy !== "object" || Array.isArray(policy.policy)) return {};
	return policy.policy as Record<string, unknown>;
}

function thresholdRecord(value: unknown): ThresholdConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.actionableMin !== "number" || typeof record.noiseMax !== "number") return undefined;
	return { actionableMin: record.actionableMin, noiseMax: record.noiseMax };
}

function scopedThresholds(
	base: ThresholdConfig,
	event: SourceEvent,
	policy: StoredPolicy | undefined,
): ThresholdConfig {
	const policyData = policyRecord(policy);
	const policyThresholds = thresholdRecord(policyData.thresholds);
	const policyScopes = policyData.scopes && typeof policyData.scopes === "object" ? policyData.scopes : undefined;
	const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
	const values: Array<[string, string | undefined]> = [
		["source", event.source],
		["service", event.service],
		["monitor", typeof metadata.monitor === "string" ? metadata.monitor : undefined],
		["environment", typeof metadata.environment === "string" ? metadata.environment : undefined],
		["repository", event.repository],
	];
	let selected = { actionableMin: base.actionableMin, noiseMax: base.noiseMax };
	if (policyThresholds) selected = { ...selected, ...policyThresholds };
	for (const [scope, value] of values) {
		if (!value) continue;
		const fromConfig = base.scopes?.[scope as keyof NonNullable<ThresholdConfig["scopes"]>];
		const configValue =
			fromConfig && typeof fromConfig === "object" ? (fromConfig as Record<string, unknown>)[value] : undefined;
		const policyValue =
			policyScopes && typeof policyScopes === "object" && scope in policyScopes
				? ((policyScopes as Record<string, unknown>)[scope] as Record<string, unknown> | undefined)?.[value]
				: undefined;
		const override = thresholdRecord(policyValue) ?? thresholdRecord(configValue);
		if (override) selected = { ...selected, ...override };
	}
	return validThresholds(selected);
}

function policyScopes(event: SourceEvent): string[] {
	const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
	return [
		event.repository ? `repository:${event.repository}` : undefined,
		typeof metadata.monitor === "string" ? `monitor:${metadata.monitor}` : undefined,
		event.service ? `service:${event.service}` : undefined,
		typeof metadata.environment === "string" ? `environment:${metadata.environment}` : undefined,
		`source:${event.source}`,
		"default",
	].filter((value): value is string => Boolean(value));
}

function eventFingerprint(event: SourceEvent): string {
	return (
		event.fingerprint ??
		createHash("sha256")
			.update(
				JSON.stringify({
					source: event.source,
					sourceKey: event.sourceKey,
					title: event.title,
					body: event.body,
				}),
			)
			.digest("hex")
	);
}

function queryForEvent(event: SourceEvent, caseId: string, limit: number): RelatedCaseQuery {
	return {
		caseId,
		sourceKeys: [event.sourceKey],
		fingerprints: event.fingerprint ? [event.fingerprint] : [],
		text: event.title,
		limit,
	};
}

export class Classifier {
	private readonly options: ClassifierOptions;

	constructor(options: ClassifierOptions) {
		requiredText(options.modelVersion, "modelVersion");
		this.options = options;
	}

	async classify(caseId: string, event: SourceEvent): Promise<ClassificationResult> {
		const policy = this.options.policyScope
			? this.options.database.getActivePolicy(this.options.policyScope)
			: policyScopes(event)
					.map((scope) => this.options.database.getActivePolicy(scope))
					.find(Boolean);
		const thresholds = scopedThresholds(
			this.options.thresholds ?? { actionableMin: 70, noiseMax: 30 },
			event,
			policy,
		);
		const relatedCases = retrieveRelatedCases(
			this.options.database,
			queryForEvent(event, caseId, this.options.relatedCaseLimit ?? 8),
		);
		const examples = approvedClassifierExamples(this.options.database, this.options.exampleLimit ?? 12);
		const request: ClassifierLaunchRequest = {
			role: "classifier",
			tools: [],
			structuredOutput: true,
			outputSchema: CLASSIFIER_OUTPUT_SCHEMA,
			event,
			policyVersion: policy?.version ?? "default",
			policy: policy?.policy ?? {},
			thresholds,
			examples,
			relatedCases,
		};
		const result = output(await this.options.launch(request));
		const classification: Classification = {
			inputKind: result.inputKind,
			disposition: applyThresholds(result, thresholds),
			actionability: result.actionability,
			noise: result.noise,
			confidence: result.confidence,
			rationale: result.rationale,
			fingerprint: eventFingerprint(event),
			policyVersion: request.policyVersion,
			modelVersion: this.options.modelVersion,
			influentialExamples: examples.map((example) => example.id),
		};
		if (this.options.isAuthorized && !this.options.isAuthorized())
			throw new Error("attempt was invalidated before classification publication");
		const classificationId = this.options.database.insertClassification(caseId, classification);
		return { classificationId, classification, relatedCases, request };
	}
}

export function classifyCase(
	options: ClassifierOptions,
	caseId: string,
	event: SourceEvent,
): Promise<ClassificationResult> {
	return new Classifier(options).classify(caseId, event);
}
