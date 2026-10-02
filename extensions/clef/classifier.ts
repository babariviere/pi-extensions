import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import { CLASSIFIER_API, MODEL_SPECS } from "./config.ts";
import type { ClefWorker } from "./worker.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate again after onPayload so replacements cannot select files or execute worker operations. */
export function wirePayload(context: unknown, temperature = 1): Record<string, unknown> {
	if (!isRecord(context) || !isRecord(context.state) || !isRecord(context.questions))
		throw new Error("Clef requires JSON object state and questions");
	if (!Number.isFinite(temperature) || temperature <= 0) throw new Error("Clef temperature must be positive");
	const questions = Object.entries(context.questions);
	if (!questions.length || questions.length > 100) throw new Error("Clef requires 1 to 100 questions");
	return {
		state: context.state,
		temperature,
		questions: Object.fromEntries(
			questions.map(([id, question]) => {
				if (!isRecord(question) || typeof question.instructions !== "string")
					throw new Error(`Invalid Clef question: ${id}`);
				const { type, instructions, criteria } = question;
				const labels =
					type === "score" && Array.isArray(criteria)
						? criteria
						: isRecord(criteria)
							? Object.values(criteria)
							: [];
				if (!labels.length || labels.length > 256 || labels.some((label) => typeof label !== "string"))
					throw new Error(`Invalid Clef criteria: ${id}`);
				if (
					type === "bool" &&
					(!isRecord(criteria) ||
						Object.keys(criteria).length !== 2 ||
						!("true" in criteria) ||
						!("false" in criteria))
				)
					throw new Error(`Invalid Clef bool criteria: ${id}`);
				if (type !== "choice" && type !== "score" && type !== "bool")
					throw new Error(`Invalid Clef question type: ${id}`);
				if (type === "score" ? !Array.isArray(criteria) : !isRecord(criteria))
					throw new Error(`Invalid Clef criteria: ${id}`);
				return [id, { type: type === "bool" ? "noul" : type, instructions, criteria }];
			}),
		),
	};
}

export function parseResult(value: unknown, context: ClassifierContext): Pick<ClassifierResult, "answers" | "usage"> {
	if (
		!isRecord(value) ||
		!isRecord(value.probabilities) ||
		!Number.isSafeInteger(value.inputTokens) ||
		(value.inputTokens as number) < 0
	)
		throw new Error("Invalid Clef classification result");
	const entries = Object.entries(context.questions).map(([id, question]) => {
		const raw = (value.probabilities as Record<string, unknown>)[id];
		const labels =
			question.type === "bool"
				? ["true", "false"]
				: question.type === "score"
					? question.criteria.map((_, i) => String(i))
					: Object.keys(question.criteria);
		if (
			!isRecord(raw) ||
			Object.keys(raw).length !== labels.length ||
			labels.some((label) => !Object.hasOwn(raw, label))
		)
			throw new Error(`Invalid Clef probabilities: ${id}`);
		const probabilities = Object.fromEntries(
			labels.map((label) => {
				const p = raw[label];
				if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1)
					throw new Error(`Invalid Clef probability: ${id}`);
				return [label, p];
			}),
		);
		const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
		if (Math.abs(sum - 1) > 0.0001) throw new Error(`Clef probabilities do not sum to one: ${id}`);
		if (question.type === "bool") return [id, { type: "bool" as const, probability: probabilities.true }] as const;
		const confidence = Math.max(...Object.values(probabilities));
		if (question.type === "score")
			return [
				id,
				{
					type: "score" as const,
					score: labels.reduce((sum, label, i) => sum + i * probabilities[label], 0),
					confidence,
				},
			] as const;
		const choice = labels.reduce((best, label) => (probabilities[label] > probabilities[best] ? label : best));
		return [id, { type: "choice" as const, choice, probabilities, confidence }] as const;
	});
	const input = value.inputTokens as number;
	return {
		answers: Object.fromEntries(entries),
		usage: {
			input,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

export async function classifyClef(
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	worker: Pick<ClefWorker, "request">,
	options?: ClassifierOptions,
	expectedModelId: string = MODEL_SPECS.flash.id,
): Promise<ClassifierResult> {
	const result: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	try {
		if (model.api !== CLASSIFIER_API || model.id !== expectedModelId)
			throw new Error("Unsupported Clef model or API for the configured worker");
		if (options?.signal?.aborted) throw new Error("Clef classification aborted");
		wirePayload(context, options?.temperature);
		const transformed = await options?.onPayload?.(context, model);
		const effective = transformed === undefined ? context : transformed;
		const payload = wirePayload(effective, options?.temperature);
		const response = await worker.request(payload, { signal: options?.signal, timeoutMs: options?.timeoutMs });
		Object.assign(result, parseResult(response, effective as ClassifierContext));
	} catch (error) {
		result.stopReason = options?.signal?.aborted ? "aborted" : "error";
		result.errorMessage = error instanceof Error ? error.message : "Clef classification failed";
	}
	return result;
}
