// Static detection lets Spindle start known orchestration programs with the
// longer agent deadline. The runtime also re-checks each host call, so a
// blocking agent ref reached through a computed path cannot fall back to the
// short executor timeout.
const BLOCKING_ORCHESTRATION_REFS = new Set(["agents.run", "agents.runAll"]);

// Host calls that block the sandbox for as long as the underlying process runs.
// An explicit timeout on these has to extend the execution deadline, otherwise
// the executor kills the program before the call it was told to wait for.
const BLOCKING_HOST_TIMEOUT_REFS = new Set(["pi.bash"]);

export const isBlockingOrchestrationRef = (ref: string): boolean => BLOCKING_ORCHESTRATION_REFS.has(ref);

export const isBlockingHostTimeoutRef = (ref: string): boolean => BLOCKING_HOST_TIMEOUT_REFS.has(ref);

const finiteNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Explicit timeout requested by a blocking host call, in milliseconds. Returns
 * 0 when the call carries no usable timeout. `pi.bash` takes `timeout` in
 * seconds (the guest proxy converts `timeoutMs` before the host sees the args),
 * `agents.run` takes `timeoutMs`.
 */
export const requestedBlockingTimeoutMs = (ref: string, args: Record<string, unknown>): number => {
	if (ref === "agents.run") return finiteNumber(args.timeoutMs) ?? 0;
	if (ref === "pi.bash") {
		const milliseconds = finiteNumber(args.timeoutMs);
		if (milliseconds !== undefined) return milliseconds;
		const seconds = finiteNumber(args.timeout);
		return seconds === undefined ? 0 : seconds * 1_000;
	}
	return 0;
};

// Match blocking guest entry points as call sites (a trailing "(").
const ORCHESTRATION_RE = /\bagents\.(?:run|runAll)\s*\(/;

export const codeUsesOrchestration = (code: string): boolean => ORCHESTRATION_RE.test(code);
