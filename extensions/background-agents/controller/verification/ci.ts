import type { ReplayProcessResult, ReplayProcessRunner } from "./reproduce.ts";

export type CiState = "pass" | "fail" | "pending" | "missing";
export interface CiCheckResult {
	name: string;
	state: CiState;
	detail?: string;
}
export interface PullRequestIdentity {
	number: number;
	headSha: string;
	baseSha?: string;
}
export interface CiVerification {
	checks: Record<string, CiState>;
	results: CiCheckResult[];
	allRequiredPassed: boolean;
	missing: string[];
	uncertainties: string[];
}

function json(value: string, field: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new Error(`GitHub returned invalid ${field} JSON`);
	}
}

function asObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub response is not an object");
	return value as Record<string, unknown>;
}

function state(value: unknown): CiState {
	const normalized = String(value ?? "").toLowerCase();
	if (["success", "passed", "pass", "completed_success"].includes(normalized)) return "pass";
	if (["failure", "failed", "error", "cancelled", "canceled", "timed_out"].includes(normalized)) return "fail";
	if (["pending", "queued", "in_progress", "requested", "waiting"].includes(normalized)) return "pending";
	return "missing";
}

export async function pullRequestIdentity(
	reference: number | string,
	runner: ReplayProcessRunner,
	cwd: string,
): Promise<PullRequestIdentity> {
	const result = await runner("gh", ["pr", "view", String(reference), "--json", "number,headRefOid,baseRefOid"], {
		cwd,
	});
	if (result.code !== 0) throw new Error(result.stderr || "unable to read pull request");
	const object = asObject(json(result.stdout, "pull request"));
	const number = Number(object.number);
	const headSha = String(object.headRefOid ?? "");
	if (!Number.isSafeInteger(number) || number <= 0 || !/^[0-9a-f]{40}$/i.test(headSha))
		throw new Error("GitHub pull request has no exact head SHA");
	return {
		number,
		headSha: headSha.toLowerCase(),
		baseSha: typeof object.baseRefOid === "string" ? object.baseRefOid : undefined,
	};
}

/** Check only named required checks. Unlisted checks never make a PR ready. */
export async function checkRequiredCi(
	reference: number | string,
	requiredChecks: readonly string[],
	runner: ReplayProcessRunner,
	cwd: string,
): Promise<CiVerification> {
	const result = await runner("gh", ["pr", "checks", String(reference), "--json", "name,state,workflow"], { cwd });
	if (result.code !== 0 && !result.stdout.trim())
		throw new Error(result.stderr || "unable to read pull request checks");
	const value = json(result.stdout || "[]", "checks");
	if (!Array.isArray(value)) throw new Error("GitHub checks response is not an array");
	const available = new Map<string, CiCheckResult>();
	for (const item of value) {
		const object = asObject(item);
		const name = String(object.name ?? object.workflow ?? "").trim();
		if (name)
			available.set(name, {
				name,
				state: state(object.state ?? object.conclusion),
				detail: String(object.workflow ?? ""),
			});
	}
	const checks: Record<string, CiState> = {};
	const results: CiCheckResult[] = [];
	const missing: string[] = [];
	for (const required of requiredChecks) {
		const found = available.get(required);
		const check = found ?? { name: required, state: "missing" as const };
		checks[required] = check.state;
		results.push(check);
		if (check.state === "missing") missing.push(required);
	}
	return {
		checks,
		results,
		allRequiredPassed: requiredChecks.length === 0 || results.every((check) => check.state === "pass"),
		missing,
		uncertainties: missing.length ? [`required CI missing: ${missing.join(", ")}`] : [],
	};
}

export interface CiVerifierOptions {
	reference: number | string;
	candidateSha: string;
	requiredChecks: readonly string[];
	runner: ReplayProcessRunner;
	cwd: string;
}

export async function verifyPullRequestCi(options: CiVerifierOptions): Promise<CiVerification> {
	const identity = await pullRequestIdentity(options.reference, options.runner, options.cwd);
	if (identity.headSha !== options.candidateSha.toLowerCase()) {
		return {
			checks: {},
			results: [],
			allRequiredPassed: false,
			missing: [],
			uncertainties: ["pull request head SHA does not match candidate"],
		};
	}
	return checkRequiredCi(options.reference, options.requiredChecks, options.runner, options.cwd);
}

export type { ReplayProcessResult };
