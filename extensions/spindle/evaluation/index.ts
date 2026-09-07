import type { SpindleEditMetricsV1, SpindleEditRouteMetricsV1, SpindleEditRouteV1 } from "../audit/edit-metrics.ts";

export const SPINDLE_EVALUATION_RECORD_VERSION = 1 as const;
export const SPINDLE_EVALUATION_SUMMARY_VERSION = 1 as const;

const ROUTES: readonly SpindleEditRouteV1[] = ["edit", "write", "applyPatch", "scripted"];
const PROFILES = new Set(["anthropic", "openai", "neutral"]);
const OUTCOMES = new Set(["succeeded", "failed", "aborted", "timed_out"]);

export interface SpindleEvaluationRecordV1 {
	version: typeof SPINDLE_EVALUATION_RECORD_VERSION;
	variant: string;
	task: string;
	passed: boolean;
	metrics: SpindleEditMetricsV1;
	toolCalls?: number;
	tokens?: {
		input: number;
		output: number;
	};
}

export interface SpindleEvaluationCountSummary {
	total: number;
	meanPerRun: number;
}

export interface SpindleEvaluationOptionalCountSummary extends SpindleEvaluationCountSummary {
	measuredRuns: number;
}

export interface SpindleEvaluationVariantSummaryV1 {
	variant: string;
	tasks: {
		passed: number;
		runs: number;
		passRate: number;
	};
	routes: Record<
		SpindleEditRouteV1,
		{
			attempts: number;
			failures: number;
			attemptsPerRun: number;
			failuresPerRun: number;
		}
	>;
	guardRefusals: SpindleEvaluationCountSummary;
	repeatedEdits: {
		files: number;
		attempts: number;
		excessAttempts: number;
		meanExcessAttemptsPerRun: number;
	};
	knownFiles: SpindleEvaluationCountSummary;
	durationMs: SpindleEvaluationCountSummary;
	toolCalls?: SpindleEvaluationOptionalCountSummary;
	tokens?: {
		measuredRuns: number;
		input: SpindleEvaluationCountSummary;
		output: SpindleEvaluationCountSummary;
		total: SpindleEvaluationCountSummary;
	};
}

export interface SpindleEvaluationSummaryV1 {
	version: typeof SPINDLE_EVALUATION_SUMMARY_VERSION;
	records: number;
	variants: [SpindleEvaluationVariantSummaryV1, SpindleEvaluationVariantSummaryV1];
	comparison: {
		baseline: string;
		candidate: string;
		candidateMinusBaseline: {
			taskPassRate: number;
			routes: Record<SpindleEditRouteV1, { attemptsPerRun: number; failuresPerRun: number }>;
			guardRefusalsPerRun: number;
			repeatedEditExcessAttemptsPerRun: number;
			knownFilesPerRun: number;
			durationMsPerRun: number;
			toolCallsPerMeasuredRun?: number;
			tokensPerMeasuredRun?: {
				input: number;
				output: number;
				total: number;
			};
		};
	};
}

export class SpindleEvaluationInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SpindleEvaluationInputError";
	}
}

const fail = (location: string, message: string): never => {
	throw new SpindleEvaluationInputError(`${location}: ${message}`);
};

const objectAt = (value: unknown, location: string): Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(location, "expected an object");
	return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], location: string): void => {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) fail(`${location}.${key}`, "unknown field");
	}
};

const nonEmptyString = (value: unknown, location: string): string => {
	if (typeof value !== "string" || value.length === 0) fail(location, "expected a non-empty string");
	return value as string;
};

const nonNegativeInteger = (value: unknown, location: string): number => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		fail(location, "expected a non-negative safe integer");
	}
	return value as number;
};

const routeMetricsAt = (value: unknown, location: string): SpindleEditRouteMetricsV1 => {
	const object = objectAt(value, location);
	exactKeys(object, ["attempts", "successes", "failures"], location);
	const attempts = nonNegativeInteger(object.attempts, `${location}.attempts`);
	const successes = nonNegativeInteger(object.successes, `${location}.successes`);
	const failures = nonNegativeInteger(object.failures, `${location}.failures`);
	if (successes + failures !== attempts) fail(location, "successes plus failures must equal attempts");
	return { attempts, successes, failures };
};

const sortedUniqueStrings = (value: unknown, location: string): string[] => {
	if (!Array.isArray(value)) fail(location, "expected an array");
	const entries = value as unknown[];
	const result = entries.map((entry, index) => nonEmptyString(entry, `${location}[${index}]`));
	for (let index = 1; index < result.length; index++) {
		if (result[index - 1]! >= result[index]!) fail(location, "entries must be unique and sorted");
	}
	return result;
};

const metricsAt = (value: unknown, location: string): SpindleEditMetricsV1 => {
	const object = objectAt(value, location);
	exactKeys(
		object,
		[
			"version",
			"profile",
			"routes",
			"knownFiles",
			"repeatedAttempts",
			"guardRefusals",
			"durationMs",
			"outcome",
			"droppedKnownFiles",
			"droppedRepeatedAttempts",
		],
		location,
	);
	if (object.version !== 1) fail(`${location}.version`, "expected 1");
	if (typeof object.profile !== "string" || !PROFILES.has(object.profile)) {
		fail(`${location}.profile`, "expected anthropic, openai, or neutral");
	}
	const routesObject = objectAt(object.routes, `${location}.routes`);
	exactKeys(routesObject, ROUTES, `${location}.routes`);
	const routes = Object.fromEntries(
		ROUTES.map((route) => [route, routeMetricsAt(routesObject[route], `${location}.routes.${route}`)]),
	) as Record<SpindleEditRouteV1, SpindleEditRouteMetricsV1>;
	const knownFiles = sortedUniqueStrings(object.knownFiles, `${location}.knownFiles`);
	if (!Array.isArray(object.repeatedAttempts)) fail(`${location}.repeatedAttempts`, "expected an array");
	const repeatedEntries = object.repeatedAttempts as unknown[];
	const repeatedAttempts = repeatedEntries.map((entry, index) => {
		const entryLocation = `${location}.repeatedAttempts[${index}]`;
		const repeated = objectAt(entry, entryLocation);
		exactKeys(repeated, ["path", "attempts"], entryLocation);
		const attempts = nonNegativeInteger(repeated.attempts, `${entryLocation}.attempts`);
		if (attempts < 2) fail(`${entryLocation}.attempts`, "expected at least 2");
		return { path: nonEmptyString(repeated.path, `${entryLocation}.path`), attempts };
	});
	for (let index = 1; index < repeatedAttempts.length; index++) {
		if (repeatedAttempts[index - 1]!.path >= repeatedAttempts[index]!.path) {
			fail(`${location}.repeatedAttempts`, "paths must be unique and sorted");
		}
	}
	const guardRefusals = nonNegativeInteger(object.guardRefusals, `${location}.guardRefusals`);
	const totalFailures = ROUTES.reduce((total, route) => total + routes[route].failures, 0);
	if (guardRefusals > totalFailures) fail(`${location}.guardRefusals`, "cannot exceed route failures");
	const durationMs = nonNegativeInteger(object.durationMs, `${location}.durationMs`);
	if (typeof object.outcome !== "string" || !OUTCOMES.has(object.outcome)) {
		fail(`${location}.outcome`, "expected succeeded, failed, aborted, or timed_out");
	}
	const droppedKnownFiles =
		object.droppedKnownFiles === undefined
			? undefined
			: nonNegativeInteger(object.droppedKnownFiles, `${location}.droppedKnownFiles`);
	const droppedRepeatedAttempts =
		object.droppedRepeatedAttempts === undefined
			? undefined
			: nonNegativeInteger(object.droppedRepeatedAttempts, `${location}.droppedRepeatedAttempts`);
	if (droppedRepeatedAttempts !== undefined && droppedRepeatedAttempts > 0) {
		fail(`${location}.droppedRepeatedAttempts`, "cannot evaluate truncated repeated-edit metrics");
	}
	return {
		version: 1,
		profile: object.profile as SpindleEditMetricsV1["profile"],
		routes,
		knownFiles,
		repeatedAttempts,
		guardRefusals,
		durationMs,
		outcome: object.outcome as SpindleEditMetricsV1["outcome"],
		...(droppedKnownFiles === undefined ? {} : { droppedKnownFiles }),
		...(droppedRepeatedAttempts === undefined ? {} : { droppedRepeatedAttempts }),
	};
};

const recordAt = (value: unknown, line: number): SpindleEvaluationRecordV1 => {
	const location = `line ${line}`;
	const object = objectAt(value, location);
	exactKeys(object, ["version", "variant", "task", "passed", "metrics", "toolCalls", "tokens"], location);
	if (object.version !== 1) fail(`${location}.version`, "expected 1");
	if (typeof object.passed !== "boolean") fail(`${location}.passed`, "expected a boolean");
	const toolCalls =
		object.toolCalls === undefined ? undefined : nonNegativeInteger(object.toolCalls, `${location}.toolCalls`);
	let tokens: SpindleEvaluationRecordV1["tokens"];
	if (object.tokens !== undefined) {
		const tokenObject = objectAt(object.tokens, `${location}.tokens`);
		exactKeys(tokenObject, ["input", "output"], `${location}.tokens`);
		tokens = {
			input: nonNegativeInteger(tokenObject.input, `${location}.tokens.input`),
			output: nonNegativeInteger(tokenObject.output, `${location}.tokens.output`),
		};
	}
	return {
		version: 1,
		variant: nonEmptyString(object.variant, `${location}.variant`),
		task: nonEmptyString(object.task, `${location}.task`),
		passed: object.passed as boolean,
		metrics: metricsAt(object.metrics, `${location}.metrics`),
		...(toolCalls === undefined ? {} : { toolCalls }),
		...(tokens === undefined ? {} : { tokens }),
	};
};

export const parseSpindleEvaluationJsonl = (input: string): SpindleEvaluationRecordV1[] => {
	const records: SpindleEvaluationRecordV1[] = [];
	const assignments = new Set<string>();
	for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error) {
			fail(`line ${index + 1}`, `invalid JSON (${error instanceof Error ? error.message : String(error)})`);
		}
		const record = recordAt(value, index + 1);
		const assignment = `${record.variant}\u0000${record.task}`;
		if (assignments.has(assignment)) fail(`line ${index + 1}`, "duplicate variant and task assignment");
		assignments.add(assignment);
		records.push(record);
	}
	if (records.length === 0) fail("input", "expected at least one JSONL record");
	return records;
};

const round = (value: number): number => Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
const mean = (total: number, count: number): number => round(total / count);

const summarizeVariant = (
	variant: string,
	records: readonly SpindleEvaluationRecordV1[],
): SpindleEvaluationVariantSummaryV1 => {
	const runs = records.length;
	const passed = records.reduce((total, record) => total + Number(record.passed), 0);
	const routes = Object.fromEntries(
		ROUTES.map((route) => {
			const attempts = records.reduce((total, record) => total + record.metrics.routes[route].attempts, 0);
			const failures = records.reduce((total, record) => total + record.metrics.routes[route].failures, 0);
			return [
				route,
				{ attempts, failures, attemptsPerRun: mean(attempts, runs), failuresPerRun: mean(failures, runs) },
			];
		}),
	) as SpindleEvaluationVariantSummaryV1["routes"];
	const guardRefusals = records.reduce((total, record) => total + record.metrics.guardRefusals, 0);
	const repeatedFiles = records.reduce((total, record) => total + record.metrics.repeatedAttempts.length, 0);
	const repeatedAttempts = records.reduce(
		(total, record) => total + record.metrics.repeatedAttempts.reduce((sum, attempt) => sum + attempt.attempts, 0),
		0,
	);
	const excessAttempts = repeatedAttempts - repeatedFiles;
	const knownFiles = records.reduce(
		(total, record) => total + record.metrics.knownFiles.length + (record.metrics.droppedKnownFiles ?? 0),
		0,
	);
	const durationMs = records.reduce((total, record) => total + record.metrics.durationMs, 0);
	const measuredToolCalls = records.filter(
		(record): record is SpindleEvaluationRecordV1 & { toolCalls: number } => record.toolCalls !== undefined,
	);
	const measuredTokens = records.filter(
		(record): record is SpindleEvaluationRecordV1 & { tokens: { input: number; output: number } } =>
			record.tokens !== undefined,
	);
	const toolCalls = measuredToolCalls.reduce((total, record) => total + record.toolCalls, 0);
	const inputTokens = measuredTokens.reduce((total, record) => total + record.tokens.input, 0);
	const outputTokens = measuredTokens.reduce((total, record) => total + record.tokens.output, 0);
	return {
		variant,
		tasks: { passed, runs, passRate: mean(passed, runs) },
		routes,
		guardRefusals: { total: guardRefusals, meanPerRun: mean(guardRefusals, runs) },
		repeatedEdits: {
			files: repeatedFiles,
			attempts: repeatedAttempts,
			excessAttempts,
			meanExcessAttemptsPerRun: mean(excessAttempts, runs),
		},
		knownFiles: { total: knownFiles, meanPerRun: mean(knownFiles, runs) },
		durationMs: { total: durationMs, meanPerRun: mean(durationMs, runs) },
		...(measuredToolCalls.length === 0
			? {}
			: {
					toolCalls: {
						measuredRuns: measuredToolCalls.length,
						total: toolCalls,
						meanPerRun: mean(toolCalls, measuredToolCalls.length),
					},
				}),
		...(measuredTokens.length === 0
			? {}
			: {
					tokens: {
						measuredRuns: measuredTokens.length,
						input: { total: inputTokens, meanPerRun: mean(inputTokens, measuredTokens.length) },
						output: { total: outputTokens, meanPerRun: mean(outputTokens, measuredTokens.length) },
						total: {
							total: inputTokens + outputTokens,
							meanPerRun: mean(inputTokens + outputTokens, measuredTokens.length),
						},
					},
				}),
	};
};

export const summarizeSpindleEvaluation = (
	records: readonly SpindleEvaluationRecordV1[],
	options: { baseline?: string } = {},
): SpindleEvaluationSummaryV1 => {
	const grouped = new Map<string, SpindleEvaluationRecordV1[]>();
	for (const record of records) {
		const variantRecords = grouped.get(record.variant) ?? [];
		variantRecords.push(record);
		grouped.set(record.variant, variantRecords);
	}
	const names = [...grouped.keys()].sort();
	if (names.length !== 2) fail("input", `expected exactly two variants, received ${names.length}`);
	const baselineName = options.baseline ?? names[0]!;
	if (!grouped.has(baselineName)) fail("baseline", `unknown variant ${JSON.stringify(baselineName)}`);
	const candidateName = names.find((name) => name !== baselineName)!;
	const baseline = summarizeVariant(baselineName, grouped.get(baselineName)!);
	const candidate = summarizeVariant(candidateName, grouped.get(candidateName)!);
	const delta = (candidateValue: number, baselineValue: number): number => round(candidateValue - baselineValue);
	const comparisonRoutes = Object.fromEntries(
		ROUTES.map((route) => [
			route,
			{
				attemptsPerRun: delta(candidate.routes[route].attemptsPerRun, baseline.routes[route].attemptsPerRun),
				failuresPerRun: delta(candidate.routes[route].failuresPerRun, baseline.routes[route].failuresPerRun),
			},
		]),
	) as SpindleEvaluationSummaryV1["comparison"]["candidateMinusBaseline"]["routes"];
	const variants = [baseline, candidate] as [SpindleEvaluationVariantSummaryV1, SpindleEvaluationVariantSummaryV1];
	return {
		version: 1,
		records: records.length,
		variants,
		comparison: {
			baseline: baselineName,
			candidate: candidateName,
			candidateMinusBaseline: {
				taskPassRate: delta(candidate.tasks.passRate, baseline.tasks.passRate),
				routes: comparisonRoutes,
				guardRefusalsPerRun: delta(candidate.guardRefusals.meanPerRun, baseline.guardRefusals.meanPerRun),
				repeatedEditExcessAttemptsPerRun: delta(
					candidate.repeatedEdits.meanExcessAttemptsPerRun,
					baseline.repeatedEdits.meanExcessAttemptsPerRun,
				),
				knownFilesPerRun: delta(candidate.knownFiles.meanPerRun, baseline.knownFiles.meanPerRun),
				durationMsPerRun: delta(candidate.durationMs.meanPerRun, baseline.durationMs.meanPerRun),
				...(baseline.toolCalls === undefined || candidate.toolCalls === undefined
					? {}
					: { toolCallsPerMeasuredRun: delta(candidate.toolCalls.meanPerRun, baseline.toolCalls.meanPerRun) }),
				...(baseline.tokens === undefined || candidate.tokens === undefined
					? {}
					: {
							tokensPerMeasuredRun: {
								input: delta(candidate.tokens.input.meanPerRun, baseline.tokens.input.meanPerRun),
								output: delta(candidate.tokens.output.meanPerRun, baseline.tokens.output.meanPerRun),
								total: delta(candidate.tokens.total.meanPerRun, baseline.tokens.total.meanPerRun),
							},
						}),
			},
		},
	};
};

export const evaluateSpindleJsonl = (input: string, options: { baseline?: string } = {}): SpindleEvaluationSummaryV1 =>
	summarizeSpindleEvaluation(parseSpindleEvaluationJsonl(input), options);
