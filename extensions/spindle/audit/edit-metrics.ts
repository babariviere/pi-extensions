import type { SpindleEditProfile } from "../edit-profile.ts";
import type { SpindleExecutionOutcomeV1, SpindleExecutionTraceOperationV1, SpindleExecutionTraceV1 } from "./trace.ts";

export const SPINDLE_EDIT_METRICS_VERSION = 1 as const;

const MAX_KNOWN_FILES = 128;
const MAX_REPEATED_ATTEMPTS = 128;
const MAX_PATH_BYTES = 512;
const APPLY_PATCH_CHANGE_KINDS = new Set(["add", "update", "delete", "move"]);

export type SpindleEditRouteV1 = "edit" | "write" | "applyPatch" | "scripted";

export interface SpindleEditRouteMetricsV1 {
	attempts: number;
	successes: number;
	failures: number;
}

export interface SpindleRepeatedEditAttemptV1 {
	path: string;
	attempts: number;
}

/** Bounded aggregate edit telemetry persisted with one spindle_exec result. */
export interface SpindleEditMetricsV1 {
	version: typeof SPINDLE_EDIT_METRICS_VERSION;
	profile: SpindleEditProfile;
	routes: Record<SpindleEditRouteV1, SpindleEditRouteMetricsV1>;
	knownFiles: string[];
	repeatedAttempts: SpindleRepeatedEditAttemptV1[];
	guardRefusals: number;
	durationMs: number;
	outcome: SpindleExecutionOutcomeV1;
	droppedKnownFiles?: number;
	droppedRepeatedAttempts?: number;
}

const emptyRouteMetrics = (): SpindleEditRouteMetricsV1 => ({ attempts: 0, successes: 0, failures: 0 });

const operationRoute = (operation: SpindleExecutionTraceOperationV1): SpindleEditRouteV1 | undefined => {
	const action = operation.provider === "pi" ? operation.action : undefined;
	if (operation.ref === "pi.edit" || action === "edit") return "edit";
	if (operation.ref === "pi.write" || action === "write") return "write";
	if (operation.ref === "pi.applyPatch" || action === "applyPatch") return "applyPatch";
	if (operation.ref === "pi.bash" || operation.ref === "pi.exec" || action === "bash" || action === "exec") {
		return "scripted";
	}
	return undefined;
};

const boundedPath = (value: unknown): string | undefined => {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) {
		return undefined;
	}
	return value;
};

const projectedPatchPaths = (operation: SpindleExecutionTraceOperationV1): string[] => {
	const paths = new Set<string>();
	if (Array.isArray(operation.args.paths)) {
		for (const candidate of operation.args.paths) {
			const path = boundedPath(candidate);
			if (path !== undefined) paths.add(path);
		}
	}
	if (typeof operation.result !== "object" || operation.result === null || Array.isArray(operation.result)) {
		return [...paths];
	}
	const changes = operation.result.changes;
	if (!Array.isArray(changes)) return [...paths];
	for (const change of changes) {
		if (typeof change !== "object" || change === null || Array.isArray(change)) continue;
		if (typeof change.kind !== "string" || !APPLY_PATCH_CHANGE_KINDS.has(change.kind)) continue;
		const path = boundedPath(change.path);
		if (path !== undefined) paths.add(path);
		const moveTo = boundedPath(change.moveTo);
		if (moveTo !== undefined) paths.add(moveTo);
	}
	return [...paths];
};

const boundedDuration = (elapsedMs: number): number => {
	if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.round(elapsedMs));
};

/**
 * Derives metrics exclusively from the already-projected durable trace. It does
 * not inspect guest code, payloads, patch text, command bodies, errors, or live
 * audit previews.
 */
export const createSpindleEditMetrics = (input: {
	trace: SpindleExecutionTraceV1;
	elapsedMs: number;
	profile: SpindleEditProfile;
}): SpindleEditMetricsV1 => {
	const routes: Record<SpindleEditRouteV1, SpindleEditRouteMetricsV1> = {
		edit: emptyRouteMetrics(),
		write: emptyRouteMetrics(),
		applyPatch: emptyRouteMetrics(),
		scripted: emptyRouteMetrics(),
	};
	const affectedFiles = new Set<string>();
	const attemptsByPath = new Map<string, number>();
	let guardRefusals = 0;

	for (const operation of input.trace.operations) {
		const route = operationRoute(operation);
		if (route === undefined) continue;
		const routeMetrics = routes[route];
		routeMetrics.attempts++;
		if (operation.outcome === "succeeded") routeMetrics.successes++;
		else routeMetrics.failures++;
		if (operation.failureStage === "guard") guardRefusals++;

		const paths =
			route === "edit" || route === "write"
				? [boundedPath(operation.args.path)].filter((path): path is string => path !== undefined)
				: route === "applyPatch"
					? projectedPatchPaths(operation)
					: [];
		for (const path of paths) {
			attemptsByPath.set(path, (attemptsByPath.get(path) ?? 0) + 1);
			if (operation.outcome === "succeeded") affectedFiles.add(path);
		}
	}

	const comparePaths = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
	const allKnownFiles = [...affectedFiles].sort(comparePaths);
	const allRepeatedAttempts = [...attemptsByPath]
		.filter(([, attempts]) => attempts > 1)
		.sort(([left], [right]) => comparePaths(left, right))
		.map(([path, attempts]) => ({ path, attempts }));
	const knownFiles = allKnownFiles.slice(0, MAX_KNOWN_FILES);
	const repeatedAttempts = allRepeatedAttempts.slice(0, MAX_REPEATED_ATTEMPTS);

	return {
		version: SPINDLE_EDIT_METRICS_VERSION,
		profile: input.profile,
		routes,
		knownFiles,
		repeatedAttempts,
		guardRefusals,
		durationMs: boundedDuration(input.elapsedMs),
		outcome: input.trace.outcome,
		...(allKnownFiles.length > knownFiles.length
			? { droppedKnownFiles: allKnownFiles.length - knownFiles.length }
			: {}),
		...(allRepeatedAttempts.length > repeatedAttempts.length
			? { droppedRepeatedAttempts: allRepeatedAttempts.length - repeatedAttempts.length }
			: {}),
	};
};
