/**
 * herdr backend: spawn each subagent as a `pi` instance in its own pane inside a
 * fresh "subagents" tab, then wait for each run's output file to settle.
 *
 * Lifecycle: create a fresh tab per run, build an evenly-sized vertical stack of
 * panes (reusing the tab's root pane as the first one), launch one titled `pi`
 * per agent, and once every run has settled and its output has been read, close
 * the whole tab (removing all panes). Panes are live while running so the user
 * can watch and interact; they are torn down only after the batch completes.
 *
 * Balance: `herdr agent start` cannot set a split ratio, so spawning N agents by
 * repeatedly splitting the focused pane squashed later panes (50/25/12.5...).
 * Instead we split panes ourselves with computed ratios so every pane ends up
 * ~1/N of the height, then launch `pi` in each via a tiny launcher script. Split
 * panes inherit HERDR_* env, so pi still self-reports as an agent.
 *
 * Completion: each run races the output file becoming stable against a blocking
 * `herdr wait agent-status` (idle-after-working, or pane gone) rather than
 * polling, so we finalize promptly whether the agent wrote its file, finished
 * without writing, or was terminated by the user.
 */

import { writeFileSync } from "node:fs";

import {
	closeTab,
	createTab,
	currentWorkspaceId,
	paneLabel,
	readPane,
	renamePane,
	runInPane,
	splitPaneDown,
	waitForAgentFinish,
} from "./herdr.ts";
import { buildChildArgs } from "./pi-args.ts";
import { runPaths } from "./paths.ts";
import { readDefaultProvider } from "./settings.ts";
import {
	ensureRunDir,
	type OnStatus,
	readOutputFile,
	type RunOutcome,
	type RunRequest,
	type RunResult,
	waitForRunCompletion,
	writeSystemPrompt,
} from "./run.ts";

export const SUBAGENTS_TAB_LABEL = "subagents";

export interface HerdrContext {
	sessionId: string | undefined;
	runId: string;
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onStatus?: OnStatus;
}

export async function runInHerdr(reqs: RunRequest[], ctx: HerdrContext): Promise<RunResult[]> {
	const workspaceId = currentWorkspaceId();
	const tab = await createTab(SUBAGENTS_TAB_LABEL, workspaceId);
	if (!tab || !tab.rootPaneId) {
		for (const req of reqs) ctx.onStatus?.(req.index, { state: "failed" });
		return reqs.map((req) => failResult(req, "could not create the herdr 'subagents' tab"));
	}

	// Prepare each run's files/args up front (pure, order-independent).
	const defaultProvider = readDefaultProvider(ctx.cwd);
	const prepared = reqs.map((req) => prepareRun(req, ctx, defaultProvider));

	// Build an evenly-sized vertical stack. The tab's root pane is pane 0; each
	// subsequent pane is made by splitting the previously-created pane with ratio
	// 1/(N-k+1), which leaves every pane at ~1/N of the height.
	const n = prepared.length;
	let prevPaneId = tab.rootPaneId;
	for (let k = 1; k < n; k++) {
		const split = await splitPaneDown(prevPaneId, 1 / (n - k + 1), ctx.cwd);
		if (!split.ok || !split.paneId) {
			prepared[k].error = split.error ?? "failed to split pane";
			continue;
		}
		prepared[k].paneId = split.paneId;
		prevPaneId = split.paneId;
	}
	prepared[0].paneId = tab.rootPaneId;

	// Launch pi in every pane now that the geometry is settled.
	const spawned = await Promise.all(prepared.map((p) => launchRun(p, ctx)));

	const results = await Promise.all(spawned.map((s) => settleRun(s, ctx)));

	// All runs settled and their output has been read: tear down the tab.
	await closeTab(tab.tabId);

	return results;
}

interface PreparedRun {
	req: RunRequest;
	outputPath: string;
	launchPath: string;
	paneId?: string;
	error?: string;
}

interface SpawnedRun {
	req: RunRequest;
	outputPath: string;
	paneId?: string;
	error?: string;
}

/** Write the per-run files and the launcher script; no herdr calls yet. */
function prepareRun(req: RunRequest, ctx: HerdrContext, defaultProvider: string | undefined): PreparedRun {
	const paths = runPaths(ctx.sessionId, ctx.runId, req.agent.config.name, req.index);
	ensureRunDir(paths.dir);

	const hasPrompt = req.agent.systemPrompt.trim().length > 0;
	if (hasPrompt) writeSystemPrompt(paths.promptPath, req.agent.systemPrompt);

	const args = buildChildArgs(req.agent, req.task, {
		sessionFile: paths.sessionPath,
		outputPath: paths.outputPath,
		systemPromptFile: hasPrompt ? paths.promptPath : undefined,
		defaultProvider,
	});

	// A tiny POSIX launcher keeps all argument quoting inside /bin/sh, avoiding
	// pane-shell (fish/zsh) quoting differences. `exec` makes pi the pane process.
	const script = `#!/bin/sh\nexec pi ${args.map(shQuote).join(" ")}\n`;
	writeFileSync(paths.launchPath, script, { mode: 0o700 });

	return { req, outputPath: paths.outputPath, launchPath: paths.launchPath };
}

/** Rename the pane and start pi in it via the launcher script. */
async function launchRun(p: PreparedRun, ctx: HerdrContext): Promise<SpawnedRun> {
	if (p.error || !p.paneId) {
		ctx.onStatus?.(p.req.index, { state: "failed", paneId: p.paneId, outputPath: p.outputPath });
		return { req: p.req, outputPath: p.outputPath, paneId: p.paneId, error: p.error ?? "no pane" };
	}

	await renamePane(p.paneId, paneLabel(p.req.agent.config.name, p.req.task));
	const started = await runInPane(p.paneId, `sh ${shQuote(p.launchPath)}`);

	ctx.onStatus?.(p.req.index, {
		state: started.ok ? "running" : "failed",
		paneId: p.paneId,
		outputPath: p.outputPath,
	});

	return {
		req: p.req,
		outputPath: p.outputPath,
		paneId: p.paneId,
		error: started.ok ? undefined : started.error,
	};
}

/** POSIX single-quote a shell argument. Safe for /bin/sh in the launcher. */
function shQuote(value: string): string {
	if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function settleRun(s: SpawnedRun, ctx: HerdrContext): Promise<RunResult> {
	if (s.error) {
		return failResult(s.req, s.error, s.paneId, s.outputPath);
	}
	const report = (ok: boolean) =>
		ctx.onStatus?.(s.req.index, { state: ok ? "done" : "failed", paneId: s.paneId, outputPath: s.outputPath });

	// Liveness: a blocking herdr wait resolves when the agent finishes its turn
	// (idle after working) or its pane is terminated. This races the output-file
	// check so we stop promptly instead of blocking for the full timeout. The
	// AbortController tears down the lingering `herdr wait` once the run settles.
	const paneId = s.paneId;
	const ac = new AbortController();
	const agentSignal = paneId ? waitForAgentFinish(paneId, ctx.timeoutMs, { signal: ac.signal }) : undefined;

	let outcome: RunOutcome;
	try {
		outcome = await waitForRunCompletion(s.outputPath, { timeoutMs: ctx.timeoutMs, agentSignal });
	} finally {
		ac.abort();
	}

	let output = readOutputFile(s.outputPath);
	if (output === undefined && paneId) {
		// The pane may have finished/errored without writing; fall back to scrollback.
		output = await readPane(paneId);
	}

	const ok = outcome === "stable" && output !== undefined;
	report(ok);
	return {
		agent: s.req.agent.config.name,
		scope: s.req.agent.scope,
		ok,
		output: output ?? "(no output produced before the pane finished or was terminated)",
		outputPath: s.outputPath,
		paneId: s.paneId,
		error: ok ? undefined : outcomeError(outcome),
	};
}

function outcomeError(outcome: RunOutcome): string {
	switch (outcome) {
		case "gone":
			return "the subagent pane was terminated before it wrote its output file";
		case "finished":
			return "the subagent finished (went idle) without writing its output file";
		case "timeout":
			return "output file did not appear before timeout";
		default:
			return "the output file was incomplete";
	}
}

function failResult(req: RunRequest, error: string, paneId?: string, outputPath = ""): RunResult {
	return {
		agent: req.agent.config.name,
		scope: req.agent.scope,
		ok: false,
		output: `(failed to run in herdr: ${error})`,
		outputPath,
		paneId,
		error,
	};
}
