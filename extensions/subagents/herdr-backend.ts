/**
 * herdr backend: spawn each subagent as a `pi` instance in its own pane inside a
 * fresh "subagents" tab, then wait for each run's output file to settle.
 *
 * Lifecycle: create a fresh tab per run, close the empty root pane herdr ships
 * with it, spawn one titled pane per agent, and once every run has settled and
 * its output has been read, close the whole tab (removing all panes). Panes are
 * live while running so the user can watch and interact; they are torn down only
 * after the batch completes.
 */

import {
	closePane,
	closeTab,
	createTab,
	currentWorkspaceId,
	paneLabel,
	readPane,
	startAgentPane,
	waitAgentDone,
} from "./herdr.ts";
import { buildChildArgs } from "./pi-args.ts";
import { runPaths } from "./paths.ts";
import { readDefaultProvider } from "./settings.ts";
import { ensureRunDir, type OnStatus, readOutputFile, type RunRequest, type RunResult, waitForStableFile, writeSystemPrompt } from "./run.ts";

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
	if (!tab) {
		for (const req of reqs) ctx.onStatus?.(req.index, { state: "failed" });
		return reqs.map((req) => failResult(req, "could not create the herdr 'subagents' tab"));
	}

	// Spawn every pane first, then wait for all of them (block until all finish).
	const defaultProvider = readDefaultProvider(ctx.cwd);
	const spawned = await Promise.all(reqs.map((req) => spawnPane(req, ctx, tab.tabId, defaultProvider)));

	// The fresh tab ships with one empty root pane; drop it so nothing lingers.
	if (tab.rootPaneId) await closePane(tab.rootPaneId);

	const results = await Promise.all(spawned.map((s) => settleRun(s, ctx)));

	// All runs settled and their output has been read: tear down the tab.
	await closeTab(tab.tabId);

	return results;
}

interface SpawnedRun {
	req: RunRequest;
	outputPath: string;
	paneId?: string;
	error?: string;
}

async function spawnPane(req: RunRequest, ctx: HerdrContext, tabId: string, defaultProvider: string | undefined): Promise<SpawnedRun> {
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

	const started = await startAgentPane({
		label: paneLabel(req.agent.config.name, req.task),
		tabId,
		cwd: ctx.cwd,
		argv: ["pi", ...args],
	});

	if (started.ok) {
		ctx.onStatus?.(req.index, { state: "running", paneId: started.paneId, outputPath: paths.outputPath });
	} else {
		ctx.onStatus?.(req.index, { state: "failed", paneId: started.paneId, outputPath: paths.outputPath });
	}

	return {
		req,
		outputPath: paths.outputPath,
		paneId: started.paneId,
		error: started.ok ? undefined : started.error,
	};
}

async function settleRun(s: SpawnedRun, ctx: HerdrContext): Promise<RunResult> {
	if (s.error) {
		return failResult(s.req, s.error, s.paneId, s.outputPath);
	}
	const report = (ok: boolean) =>
		ctx.onStatus?.(s.req.index, { state: ok ? "done" : "failed", paneId: s.paneId, outputPath: s.outputPath });

	let done = false;
	if (s.paneId) {
		// Fire the pane-status wait in the background; used as a secondary signal.
		void waitAgentDone(s.paneId, ctx.timeoutMs).then((d) => {
			done = d;
		});
	}

	const stable = await waitForStableFile(s.outputPath, { timeoutMs: ctx.timeoutMs, isDone: () => done });
	let output = readOutputFile(s.outputPath);

	if (output === undefined && s.paneId) {
		// The pane may have errored without writing; fall back to scrollback.
		output = await readPane(s.paneId);
	}

	const ok = stable && output !== undefined;
	report(ok);
	return {
		agent: s.req.agent.config.name,
		scope: s.req.agent.scope,
		ok,
		output: output ?? "(no output file produced before the pane was torn down)",
		outputPath: s.outputPath,
		paneId: s.paneId,
		error: ok ? undefined : "output file did not appear before timeout",
	};
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
