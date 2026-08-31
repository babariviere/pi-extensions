/**
 * The "a night run is in flight" handshake.
 *
 * `/night start` writes a small JSON file to a fixed path; anything that spawns
 * a subagent reads it back to learn the report path and the hard rules. A file
 * (rather than the event bus) because subagents are separate `pi` processes, so
 * an in-memory channel would not reach them.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

/**
 * Filesystem sandbox a night run asks Spindle for. Deliberately a plain shape
 * rather than an import from spindle: night-mode must not depend on it.
 */
export interface NightSandboxRequest {
	mode: "off" | "read-only" | "workspace-write" | "full";
	/** Extra writable roots on top of the run's working directory. */
	allowWrite?: string[];
	/**
	 * Domains the run needs to reach, unioned into whatever the session's own
	 * config allows. The only place a night run *widens* a policy instead of
	 * tightening it: an overnight run that cannot reach the forge fails at 3am
	 * with nobody awake to add a domain, and egress is not the destructive path
	 * this sandbox is about. A domain in the config's `deniedDomains` still wins,
	 * so the kill switch survives.
	 */
	network?: { allowedDomains?: string[] };
}

export interface ActiveNightRun {
	/** Epoch ms the run was started. */
	startedAt: number;
	/** Absolute path of the report every participant appends to. */
	reportPath: string;
	/** Hard cap on pull requests for the whole night. */
	maxPullRequests: number;
	/** Session id of the coordinator, for debugging. */
	sessionId?: string;
	/**
	 * Per-run working copy every participant works in, when one was created.
	 * Absent means the run uses the session's own checkout.
	 */
	workspacePath?: string;
	/**
	 * Todo store backing the night ledger. Published here because the run rewrites
	 * `cwd` for its clone and again for every subagent workspace, so a child that
	 * resolved the store from its own cwd would write into a throwaway directory.
	 * Children normally receive it as `PI_TODO_PATH`; this field is what the ones
	 * that cannot be handed an environment (herdr panes) read instead.
	 */
	ledgerDir?: string;
	/**
	 * Filesystem sandbox the run asks for. Spindle reads this to sandbox the
	 * coordinator and every subagent process for the duration of the night; see
	 * `spindle/sandbox/night-bridge.ts`. Structural on purpose: night-mode does
	 * not import spindle.
	 */
	sandbox?: NightSandboxRequest;
}

/** Next to the default prompt/report files, so one feature owns one directory. */
export function activeRunPath(): string {
	const base = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(base, "night", "active.json");
}

/** The currently active night run, or undefined. Never throws. */
export function readActiveNightRun(): ActiveNightRun | undefined {
	try {
		const path = activeRunPath();
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const run = parsed as ActiveNightRun;
		return typeof run.reportPath === "string" && run.reportPath ? run : undefined;
	} catch {
		return undefined;
	}
}

export function writeActiveNightRun(run: ActiveNightRun): void {
	try {
		const path = activeRunPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, "utf-8");
	} catch {
		// Best effort: a missing handshake only costs subagents their contract.
	}
}

export function clearActiveNightRun(): void {
	try {
		rmSync(activeRunPath(), { force: true });
	} catch {
		// already gone
	}
}

/**
 * Set on every `pi` child spawned for a night run, so the child knows it is a
 * participant. The handshake file is global and readable by any process; an
 * interactive session started at 2am must not inherit the run's sandbox just
 * because a run happens to be in flight.
 */
export const NIGHT_RUN_ENV = "PI_NIGHT_RUN";

/** True when `candidate` is `root` or lives under it. */
function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Whether this process belongs to `run`, and so should inherit its policy.
 *
 * Three ways to qualify, because there is no single channel that reaches every
 * participant:
 *
 *  - the `NIGHT_RUN_ENV` marker, set on children spawned by the run,
 *  - being the coordinator session that started the run (`sessionId`),
 *  - running inside the run's private working copy, or one of the per-subagent
 *    workspaces beside it (`<clone>.agents/...`), which covers children the
 *    spawn path could not hand an environment to (herdr panes).
 *
 * Anything else (a normal session in the user's own checkout) is not a
 * participant and keeps whatever `spindle.json` configures.
 */
export function isNightRunParticipant(run: ActiveNightRun, ref: { sessionId?: string; cwd?: string }): boolean {
	if (process.env[NIGHT_RUN_ENV] === "1") return true;
	if (run.sessionId && ref.sessionId && run.sessionId === ref.sessionId) return true;
	const clone = run.workspacePath;
	if (!clone || !ref.cwd) return false;
	return isInside(clone, ref.cwd) || isInside(`${clone}.agents`, ref.cwd);
}

/**
 * The condensed rules every subagent of a night run inherits. Prepended to the
 * child's task message rather than left to the agent definition, so it cannot
 * be skipped by picking an agent that does not know about night mode.
 *
 * `workspacePath` is the child's own working copy when it was given one (see
 * `agent-workspace.ts`). The wording differs on purpose: a child with its own
 * workspace is already there and must not wander into the shared clone, while a
 * child without one has to `cd` into the run's clone itself.
 */
export function buildNightContract(run: ActiveNightRun, workspacePath?: string): string {
	const workspace = workspacePath ?? run.workspacePath;
	const workspaceLine = workspace
		? workspacePath
			? `- Work in \`${workspace}\`: your own workspace for this task, and already your working directory. Everything you change belongs there; never touch the user's own checkout.`
			: `- Work in \`${workspace}\`: a private copy of the repo made for tonight. \`cd\` there first and never touch the user's own checkout.`
		: undefined;
	return [
		"[night-mode] You are part of an unattended overnight run. Nobody is awake to answer.",
		"Hard rules, no exceptions:",
		"- Never ask a question and never wait for confirmation. If a choice is genuinely ambiguous or risky, skip the work and say so in your final message.",
		"- Read-only on anything that talks to people: never send a message, reply, comment, DM, email or reaction on the user's behalf.",
		...(workspaceLine ? [workspaceLine] : []),
		"- Never push to the default branch, never merge, never force-push a branch you do not own.",
		"- Every pull request you open is a draft.",
		`- The whole night is capped at ${run.maxPullRequests} pull requests. Do not open one unless the coordinator asked you to.`,
		"- No deploys, no manual migrations, no production data changes.",
		`- Night report: \`${run.reportPath}\`. Read it if you need what happened earlier. Do not rewrite it; the coordinator owns it. Put anything worth reporting in your final message instead.`,
		"",
	].join("\n");
}
