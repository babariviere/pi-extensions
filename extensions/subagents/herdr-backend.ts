/**
 * herdr backend: spawn each subagent as a `pi` instance in its own pane inside a
 * fresh "subagents" tab, then wait for each run's output file to settle.
 *
 * Lifecycle: create a fresh tab per run, build an evenly-sized grid of panes
 * (reusing the tab's root pane as the first cell), launch one titled `pi` per
 * agent via `herdr agent start`, and once every run has settled and its output
 * has been read, close the whole tab (removing all panes). Panes are live while
 * running so the user can watch and interact; they are torn down only after the
 * batch completes.
 *
 * Balance: `herdr agent start` cannot set a split ratio, so spawning N agents by
 * repeatedly splitting the focused pane squashed later panes (50/25/12.5...).
 * Stacking them all vertically also squashes each into a thin strip. Instead we
 * tile them into a grid (see computeGrid): split the root into even columns with
 * `right` splits, then split each column into even rows with `down` splits, so
 * every pane gets a usable rectangle.
 *
 * Launch: each split pane lands at a fresh idle shell prompt, which is exactly
 * what `herdr agent start` requires (it types the launch command into that
 * shell and blocks until it detects pi is interactive-ready). We must start the
 * agent before anything else runs in the pane, or herdr reports
 * `agent_pane_busy`. The child's output path travels via the
 * `--subagent-output-path` CLI flag (see pi-args), so no env injection or
 * launcher script is needed.
 *
 * Task delivery: `agent start` types its args into a shell and rejects
 * multi-line ones, so we start pi with flags only (all single-line) and then
 * submit the (multi-line) task with `herdr agent prompt`, which uses bracketed
 * paste to deliver it as one clean user message.
 *
 * Completion: each run races the output file becoming stable against a blocking
 * `herdr agent wait` (idle-after-working, or pane gone) rather than polling, so
 * we finalize promptly whether the agent wrote its file, finished without
 * writing, or was terminated by the user.
 */

import { computeGrid } from "./grid.ts";
import {
	closeTab,
	createTab,
	currentWorkspaceId,
	paneLabel,
	promptAgent,
	readPane,
	renamePane,
	splitPane,
	startAgent,
	waitForAgentFinish,
} from "./herdr.ts";
import { buildChildArgs, formatTaskMessage } from "./pi-args.ts";
import { resolveOutputOverride, runPaths } from "./paths.ts";
import { readDefaultProvider } from "./settings.ts";
import {
	ensureRunDir,
	type OnStatus,
	readLastAssistantText,
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
	sessionFile: string | undefined;
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

	// Build an evenly-sized grid so panes get usable rectangles instead of thin
	// stacked strips. Cells are filled column-major (left-to-right, top-to-bottom).
	await buildGrid(prepared, tab.rootPaneId, ctx.cwd);

	// Launch pi in every pane now that the geometry is settled.
	const spawned = await Promise.all(prepared.map((p) => launchRun(p, ctx)));

	const results = await Promise.all(spawned.map((s) => settleRun(s, ctx)));

	// All runs settled and their output has been read: tear down the tab.
	await closeTab(tab.tabId);

	return results;
}

/**
 * Split `rootPaneId` into a grid and assign a pane id to each prepared run,
 * column-major. First we carve the root into even columns with `right` splits,
 * then each column into even rows with `down` splits. Each split keeps the
 * existing pane at ratio 1/(remaining) of that axis, so both columns and rows
 * come out evenly sized. On a split failure the affected run is marked with an
 * error and skipped; the rest of the grid still builds.
 */
async function buildGrid(prepared: PreparedRun[], rootPaneId: string, cwd: string): Promise<void> {
	const { cols, rowsPerCol } = computeGrid(prepared.length);

	// Carve out the column panes (left-to-right). The root pane becomes column 0;
	// each further column is split off the remaining right-hand region.
	const columnPanes: string[] = [rootPaneId];
	let rightRegion = rootPaneId;
	for (let c = 1; c < cols; c++) {
		const split = await splitPane(rightRegion, "right", 1 / (cols - c + 1), cwd);
		if (!split.ok || !split.paneId) {
			// Can't create this column: mark every run that would have landed in it.
			const missing = split.error ?? "failed to split column";
			for (let cc = c; cc < cols; cc++) markColumnFailed(prepared, rowsPerCol, cc, missing);
			break;
		}
		columnPanes.push(split.paneId);
		rightRegion = split.paneId;
	}

	// Split each column into its rows (top-to-bottom) and assign cells.
	let idx = 0;
	for (let c = 0; c < cols; c++) {
		const rows = rowsPerCol[c];
		const columnPane = columnPanes[c];
		if (columnPane === undefined) {
			idx += rows; // column never created; runs already marked failed above.
			continue;
		}
		let bottomRegion = columnPane;
		if (idx < prepared.length) prepared[idx].paneId = columnPane; // first row reuses the column pane
		idx++;
		for (let r = 1; r < rows; r++) {
			const split = await splitPane(bottomRegion, "down", 1 / (rows - r + 1), cwd);
			if (!split.ok || !split.paneId) {
				if (idx < prepared.length) prepared[idx].error = split.error ?? "failed to split row";
				idx++;
				continue;
			}
			if (idx < prepared.length) prepared[idx].paneId = split.paneId;
			bottomRegion = split.paneId;
			idx++;
		}
	}
}

/** Mark every prepared run that maps to column `col` as failed with `error`. */
function markColumnFailed(prepared: PreparedRun[], rowsPerCol: number[], col: number, error: string): void {
	let start = 0;
	for (let c = 0; c < col; c++) start += rowsPerCol[c];
	for (let r = 0; r < rowsPerCol[col]; r++) {
		const i = start + r;
		if (i < prepared.length && !prepared[i].error) prepared[i].error = error;
	}
}

interface PreparedRun {
	req: RunRequest;
	outputPath: string;
	sessionPath: string;
	childArgs: string[];
	paneId?: string;
	error?: string;
}

interface SpawnedRun {
	req: RunRequest;
	outputPath: string;
	sessionPath: string;
	paneId?: string;
	error?: string;
}

/** Write the per-run files and the launcher script; no herdr calls yet. */
function prepareRun(req: RunRequest, ctx: HerdrContext, defaultProvider: string | undefined): PreparedRun {
	const paths = runPaths(ctx.sessionFile, ctx.sessionId, ctx.runId, req.agent.config.name, req.index);
	ensureRunDir(paths.dir);

	const outputPath = req.output ? resolveOutputOverride(ctx.cwd, req.output) : paths.outputPath;

	const hasPrompt = req.agent.systemPrompt.trim().length > 0;
	if (hasPrompt) writeSystemPrompt(paths.promptPath, req.agent.systemPrompt);

	// Flags only: the task is submitted after start via `agent prompt`.
	const childArgs = buildChildArgs(req.agent, req.task, {
		sessionFile: paths.sessionPath,
		outputPath,
		systemPromptFile: hasPrompt ? paths.promptPath : undefined,
		defaultProvider,
		modelOverride: req.overrides?.model,
		thinkingOverride: req.overrides?.thinking,
		includeTask: false,
	});

	return { req, outputPath, sessionPath: paths.sessionPath, childArgs };
}

/**
 * Unique live agent name for `herdr agent start`. herdr requires a strict name:
 * a leading lowercase letter, then only lowercase letters, digits, `-` or `_`,
 * 1-32 chars. A short random suffix keeps names distinct across concurrent
 * batches; names are freed when the occupant exits, so per-batch reuse is fine.
 */
function agentName(index: number): string {
	const rand = Math.random().toString(36).slice(2, 8);
	return `sub-${index}-${rand}`;
}

/** Rename the pane and start pi in it via `herdr agent start`. */
async function launchRun(p: PreparedRun, ctx: HerdrContext): Promise<SpawnedRun> {
	if (p.error || !p.paneId) {
		ctx.onStatus?.(p.req.index, { state: "failed", paneId: p.paneId, outputPath: p.outputPath });
		return { req: p.req, outputPath: p.outputPath, sessionPath: p.sessionPath, paneId: p.paneId, error: p.error ?? "no pane" };
	}

	// Start pi before anything else touches the pane so it is still an idle shell.
	// A freshly split pane's shell can still be initializing (or briefly busy),
	// so startAgent waits for the pane to become ready (up to 30s) and retries.
	const started = await startAgent(agentName(p.req.index), "pi", p.paneId, p.childArgs, undefined, {
		signal: ctx.signal,
	});
	if (!started.ok) {
		ctx.onStatus?.(p.req.index, { state: "failed", paneId: p.paneId, outputPath: p.outputPath });
		return { req: p.req, outputPath: p.outputPath, sessionPath: p.sessionPath, paneId: p.paneId, error: started.error };
	}

	// Label the pane with the task so a watcher can tell panes apart, then submit
	// the task as a clean user message (bracketed paste handles its newlines).
	await renamePane(p.paneId, paneLabel(p.req.agent.config.name, p.req.task));
	const prompted = await promptAgent(p.paneId, formatTaskMessage(p.req.task, p.req.reads));

	ctx.onStatus?.(p.req.index, {
		state: prompted.ok ? "running" : "failed",
		paneId: p.paneId,
		outputPath: p.outputPath,
	});

	return {
		req: p.req,
		outputPath: p.outputPath,
		sessionPath: p.sessionPath,
		paneId: p.paneId,
		error: prompted.ok ? undefined : prompted.error,
	};
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
	if (output === undefined) {
		// The agent finished without writing the output file. This commonly means
		// it ended its turn with a plain assistant message instead of calling
		// submit_result. Recover the result from the child session transcript
		// (complete and on disk), then fall back to pane scrollback.
		output = readLastAssistantText(s.sessionPath);
		if (output === undefined && paneId) output = await readPane(paneId);
	}

	// Success when we have usable output and the agent actually finished its turn
	// (`stable` = wrote the file; `finished` = went idle, result recovered above).
	// A `gone`/`timeout` outcome stays failed even if scrollback yielded text.
	const ok = output !== undefined && (outcome === "stable" || outcome === "finished");
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
