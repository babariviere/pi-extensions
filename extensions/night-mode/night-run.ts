/**
 * The "a night run is in flight" handshake.
 *
 * `/night start` writes a small JSON file to a fixed path; anything that spawns
 * a subagent reads it back to learn the report path and the hard rules. A file
 * (rather than the event bus) because subagents are separate `pi` processes, so
 * an in-memory channel would not reach them.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ActiveNightRun {
	/** Epoch ms the run was started. */
	startedAt: number;
	/** Absolute path of the report every participant appends to. */
	reportPath: string;
	/** Hard cap on pull requests for the whole night. */
	maxPullRequests: number;
	/** Session id of the coordinator, for debugging. */
	sessionId?: string;
}

export function activeRunPath(): string {
	const base =
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(base, "night-mode", "active.json");
}

/** The currently active night run, or undefined. Never throws. */
export function readActiveNightRun(): ActiveNightRun | undefined {
	try {
		const path = activeRunPath();
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const run = parsed as ActiveNightRun;
		return typeof run.reportPath === "string" && run.reportPath
			? run
			: undefined;
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
 * The condensed rules every subagent of a night run inherits. Prepended to the
 * child's task message rather than left to the agent definition, so it cannot
 * be skipped by picking an agent that does not know about night mode.
 */
export function buildNightContract(run: ActiveNightRun): string {
	return [
		"[night-mode] You are part of an unattended overnight run. Nobody is awake to answer.",
		"Hard rules, no exceptions:",
		"- Never ask a question and never wait for confirmation. If a choice is genuinely ambiguous or risky, skip the work and say so in your final message.",
		"- Read-only on anything that talks to people: never send a message, reply, comment, DM, email or reaction on the user's behalf.",
		"- Never push to the default branch, never merge, never force-push a branch you do not own.",
		"- Every pull request you open is a draft.",
		`- The whole night is capped at ${run.maxPullRequests} pull requests. Do not open one unless the coordinator asked you to.`,
		"- No deploys, no manual migrations, no production data changes.",
		`- Night report: \`${run.reportPath}\`. Read it if you need what happened earlier. Do not rewrite it; the coordinator owns it. Put anything worth reporting in your final message instead.`,
		"",
	].join("\n");
}
