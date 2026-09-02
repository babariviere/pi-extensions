/**
 * herdr backend: spawn each subagent as a `pi` instance in its own pane inside a
 * fresh "subagents" tab, then wait for each run's transcript to settle.
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
 * `agent_pane_busy`. The child needs no output-path plumbing: its result is its
 * final assistant message, read from the transcript the parent already named
 * via `--session` (see run.ts `resolveRunOutput`).
 *
 * Task delivery: `agent start` types its args into a shell and rejects
 * multi-line ones, so we start pi with flags only (all single-line) and then
 * submit the (multi-line) task with `herdr agent prompt`, which uses bracketed
 * paste to deliver it as one clean user message. Submission is confirmed rather
 * than assumed (see `HerdrClient.promptAgent`): a swallowed submit key leaves
 * the task sitting in the composer, so a stalled submission replays the key
 * instead of reporting a running run that will never produce anything.
 *
 * Completion: each run races the transcript becoming stable against a blocking
 * `herdr agent wait` (idle-after-working, or pane gone) rather than polling, so
 * we finalize promptly whether the agent finished its turn or was terminated by
 * the user.
 */

import { computeGrid } from "./grid.ts";
import { herdr } from "./herdr-client.ts";
import { paneLabel } from "./herdr-parse.ts";
import { currentWorkspaceId } from "./herdr-transport.ts";
import { waitForAgentFinish } from "./pane-lifecycle.ts";
import { formatTaskMessage } from "./pi-args.ts";
import { readDefaultProvider } from "./settings.ts";
import { resolveRunOutput } from "./output.ts";
import { outcomeError, type RunOutcome, waitForRunCompletion } from "./herdr-completion.ts";
import { baseResult, prepareChildRun, runCwd, type RunContext, type RunRequest, type RunResult } from "./run.ts";

export const SUBAGENTS_TAB_LABEL = "subagents";

export async function runInHerdr(reqs: RunRequest[], ctx: RunContext): Promise<RunResult[]> {
	const workspaceId = currentWorkspaceId();

	// Prepare each run's files/args up front (pure, order-independent). Done
	// before the tab exists because the tab's root pane is the first run's pane,
	// so creating it needs to know that run's working directory.
	const defaultProvider = readDefaultProvider(ctx.cwd);
	const prepared = reqs.map((req) => prepareRun(req, ctx, defaultProvider));

	const tab = await herdr.createTab(
		SUBAGENTS_TAB_LABEL,
		workspaceId,
		prepared.length > 0 ? runCwd(prepared[0].req, ctx) : ctx.cwd,
	);
	if (!tab || !tab.rootPaneId) {
		for (const req of reqs) ctx.onStatus?.(req.index, { state: "failed" });
		return reqs.map((req) => failResult(req, "could not create the herdr 'subagents' tab"));
	}

	// Cancelling the parent has to reach the children: closing the tab removes
	// every pane and kills the pi processes inside them. Armed before the grid is
	// built, because launching a pane can take tens of seconds (`agent start`
	// waits for a ready shell) and an abort in that window must not be lost.
	let closed = false;
	const spawnedRuns: SpawnedRun[] = [];
	const closeTab = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		await herdr.closeTab(tab.tabId);
	};
	const teardown = async (): Promise<void> => {
		// Scrollback is the fallback output of a run with no transcript, and it dies
		// with the pane, so capture it before the tab goes away.
		await Promise.all(
			spawnedRuns.map(async (run) => {
				if (!run.paneId || run.scrollback !== undefined) return;
				run.scrollback = await herdr.readPane(run.paneId);
			}),
		);
		await closeTab();
	};
	const onAbort = (): void => {
		void teardown().catch(() => {});
	};
	ctx.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		// Build an evenly-sized grid so panes get usable rectangles instead of thin
		// stacked strips. Cells are filled column-major (left-to-right, top-to-bottom).
		await buildGrid(prepared, tab.rootPaneId, ctx);

		// Launch pi in every pane now that the geometry is settled.
		const spawned = await Promise.all(prepared.map((p) => launchRun(p, ctx)));
		spawnedRuns.push(...spawned);
		// An already-aborted signal never fires the listener.
		if (ctx.signal?.aborted) await teardown();

		return await Promise.all(spawned.map((s) => settleRun(s, ctx)));
	} finally {
		// All runs settled and their output has been read: tear down the tab.
		ctx.signal?.removeEventListener("abort", onAbort);
		await closeTab();
	}
}

/**
 * Split `rootPaneId` into a grid and assign a pane id to each prepared run,
 * column-major. First we carve the root into even columns with `right` splits,
 * then each column into even rows with `down` splits. Each split keeps the
 * existing pane at ratio 1/(remaining) of that axis, so both columns and rows
 * come out evenly sized. On a split failure the affected run is marked with an
 * error and skipped; the rest of the grid still builds.
 */
async function buildGrid(prepared: PreparedRun[], rootPaneId: string, ctx: RunContext): Promise<void> {
	const { cols, rowsPerCol } = computeGrid(prepared.length);

	// A pane's working directory is fixed when it is split, so each split uses the
	// cwd of the run that will land in the new pane rather than one cwd for the
	// whole grid: night subagents each have their own workspace.
	const cwdAt = (index: number): string => (index < prepared.length ? runCwd(prepared[index].req, ctx) : ctx.cwd);
	const firstRowOf = (col: number): number => {
		let start = 0;
		for (let c = 0; c < col; c++) start += rowsPerCol[c];
		return start;
	};

	// Carve out the column panes (left-to-right). The root pane becomes column 0;
	// each further column is split off the remaining right-hand region.
	const columnPanes: string[] = [rootPaneId];
	let rightRegion = rootPaneId;
	for (let c = 1; c < cols; c++) {
		const split = await herdr.splitPane(rightRegion, "right", 1 / (cols - c + 1), cwdAt(firstRowOf(c)));
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
			const split = await herdr.splitPane(bottomRegion, "down", 1 / (rows - r + 1), cwdAt(idx));
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
	/**
	 * Pane scrollback captured before an aborted batch's tab was closed. It is
	 * the fallback output source for a run whose transcript never landed, and it
	 * has to be read while the pane still exists.
	 */
	scrollback?: string;
}

/** Write the per-run files and args; no herdr calls yet. */
function prepareRun(req: RunRequest, ctx: RunContext, defaultProvider: string | undefined): PreparedRun {
	// Flags only: the task is submitted after start via `agent prompt`.
	const p = prepareChildRun(req, ctx, { defaultProvider, includeTask: false });
	return { req, outputPath: p.outputPath, sessionPath: p.sessionPath, childArgs: p.childArgs };
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
async function launchRun(p: PreparedRun, ctx: RunContext): Promise<SpawnedRun> {
	if (p.error || !p.paneId) {
		ctx.onStatus?.(p.req.index, { state: "failed", paneId: p.paneId, outputPath: p.outputPath });
		return {
			req: p.req,
			outputPath: p.outputPath,
			sessionPath: p.sessionPath,
			paneId: p.paneId,
			error: p.error ?? "no pane",
		};
	}

	// Start pi before anything else touches the pane so it is still an idle shell.
	// A freshly split pane's shell can still be initializing (or briefly busy),
	// so startAgent waits for the pane to become ready (up to 30s) and retries.
	const started = await herdr.startAgent(agentName(p.req.index), "pi", p.paneId, p.childArgs, undefined, {
		signal: ctx.signal,
	});
	if (!started.ok) {
		ctx.onStatus?.(p.req.index, { state: "failed", paneId: p.paneId, outputPath: p.outputPath });
		return {
			req: p.req,
			outputPath: p.outputPath,
			sessionPath: p.sessionPath,
			paneId: p.paneId,
			error: started.error,
		};
	}

	// Label the pane with the task so a watcher can tell panes apart, then submit
	// the task as a clean user message (bracketed paste handles its newlines).
	await herdr.renamePane(p.paneId, paneLabel(p.req.agent.config.name, p.req.task));
	const prompted = await herdr.promptAgent(
		p.paneId,
		formatTaskMessage(p.req.task, {
			...(p.req.reads ? { reads: p.req.reads } : {}),
			...(p.req.night ? { night: p.req.night } : {}),
			...(p.req.cwd ? { workspacePath: p.req.cwd } : {}),
			...(p.req.artifactsDir ? { artifactsDir: p.req.artifactsDir } : {}),
		}),
		{ ...(ctx.signal ? { signal: ctx.signal } : {}) },
	);

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

async function settleRun(s: SpawnedRun, ctx: RunContext): Promise<RunResult> {
	if (s.error) {
		return failResult(s.req, s.error, s.paneId);
	}
	const report = (ok: boolean) =>
		ctx.onStatus?.(s.req.index, { state: ok ? "done" : "failed", paneId: s.paneId, outputPath: s.outputPath });

	// Liveness: a blocking herdr wait resolves when the agent finishes its turn
	// (idle after working) or its pane is terminated. This races the output-file
	// check so we stop promptly instead of blocking for the full timeout. The
	// AbortController tears down the lingering `herdr wait` once the run settles.
	const paneId = s.paneId;
	const ac = new AbortController();
	const agentSignal = paneId
		? waitForAgentFinish(herdr.statusProbe(paneId), ctx.timeoutMs, { signal: ac.signal })
		: undefined;

	let outcome: RunOutcome;
	try {
		// The child writes its transcript live at sessionPath; waiting for it to
		// stop growing (or for the agent to go idle) tells us the turn is done.
		outcome = await waitForRunCompletion(s.sessionPath, { timeoutMs: ctx.timeoutMs, agentSignal });
	} finally {
		ac.abort();
	}

	// Success when we have usable output and the agent actually finished its turn
	// (`stable` = transcript settled; `finished` = went idle). A `gone`/`timeout`
	// outcome stays failed even if the pane-scrollback fallback yielded text.
	const resolved = await resolveRunOutput(s.outputPath, s.sessionPath, {
		fallback: () => s.scrollback ?? (paneId ? herdr.readPane(paneId) : undefined),
		finishedCleanly: outcome === "stable" || outcome === "finished",
		placeholder: "(no output produced before the pane finished or was terminated)",
	});
	report(resolved.ok);
	return {
		...baseResult(s.req, resolved, resolved.ok ? undefined : outcomeError(outcome)),
		backend: "herdr",
		paneId: s.paneId,
	};
}

/** A run that never got far enough to produce (or persist) output. */
function failResult(req: RunRequest, error: string, paneId?: string): RunResult {
	return {
		agent: req.agent.config.name,
		scope: req.agent.scope,
		ok: false,
		output: `(failed to run in herdr: ${error})`,
		backend: "herdr",
		paneId,
		error,
	};
}
