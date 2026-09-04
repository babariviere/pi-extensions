/**
 * Herdr backend: run each subagent as a Pi process in a pane of a fresh
 * "subagents" tab, then wait for its transcript to settle.
 *
 * A pane is created at an idle shell prompt, but Pi is launched with `pane run`
 * instead of `agent start`. `pane run` submits the quoted command and Enter in
 * one operation, avoiding the shell-input race that could leave a Pi command in
 * the composer. Pi is then discovered through its pane id for lifecycle waits.
 *
 * The task is still a file path, not terminal input. This avoids shell quoting
 * multi-line work and lets the child inject its first message after startup.
 */

import { existsSync } from "node:fs";
import { nightChildEnv, readActiveNightRun } from "../../night-mode/night-run.ts";
import { computeGrid } from "./grid.ts";
import { herdr } from "./herdr-client.ts";
import { paneLabel } from "./herdr-parse.ts";
import { currentWorkspaceId } from "./herdr-transport.ts";
import { waitForAgentFinish, waitForChildEvidence } from "./pane-lifecycle.ts";
import { readDefaultProvider } from "./settings.ts";
import { describeTranscript, hasTerminalAssistantMessage, resolveRunOutput } from "./output.ts";
import { outcomeError, type RunOutcome, waitForRunCompletion } from "./herdr-completion.ts";
import {
	baseResult,
	prepareChildRun,
	runCwd,
	withPacingDisabled,
	type RunContext,
	type RunFailure,
	type RunRequest,
	type RunResult,
} from "./run.ts";

export const SUBAGENTS_TAB_LABEL = "subagents";

/** How long to wait for a `pane run` child to appear in its transcript or pane state. */
const CHILD_EVIDENCE_TIMEOUT_MS = 20_000;

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
	// Flags only, all single-line: the task travels as a file path the child reads
	// itself (`taskDelivery: "file"`).
	const p = prepareChildRun(req, ctx, { defaultProvider, taskDelivery: "file" });
	return { req, outputPath: p.outputPath, sessionPath: p.sessionPath, childArgs: p.childArgs };
}

/** Rename the pane, run Pi atomically, then require child evidence. */
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

	await herdr.renamePane(p.paneId, paneLabel(p.req.agent.config.name, p.req.task));
	const env = withPacingDisabled(ctx.pacingDisabled, p.req.night ? nightChildEnv(readActiveNightRun(), {}) : {});
	const launched = await herdr.runPi(p.paneId, p.childArgs, env, ctx.signal);
	if (!launched.ok || !(await childIsAlive(p, ctx))) {
		const error = launched.error ?? "Pi did not start in the Herdr pane";
		ctx.onStatus?.(p.req.index, { state: "failed", paneId: p.paneId, outputPath: p.outputPath });
		return {
			req: p.req,
			outputPath: p.outputPath,
			sessionPath: p.sessionPath,
			paneId: p.paneId,
			error,
		};
	}

	ctx.onStatus?.(p.req.index, { state: "running", paneId: p.paneId, outputPath: p.outputPath });
	return { req: p.req, outputPath: p.outputPath, sessionPath: p.sessionPath, paneId: p.paneId };
}

/**
 * Is there a child in this pane? Evidence is the transcript the parent named for
 * it appearing, or herdr reporting the pane's agent in a real state; a pane that
 * has gone away is conclusive the other way. Bounded by
 * `CHILD_EVIDENCE_TIMEOUT_MS`, and never longer than the run's own timeout.
 */
async function childIsAlive(p: PreparedRun, ctx: RunContext): Promise<boolean> {
	if (!p.paneId) return false;
	const evidence = await waitForChildEvidence({
		probe: herdr.statusProbe(p.paneId),
		transcriptExists: () => existsSync(p.sessionPath),
		timeoutMs: Math.min(CHILD_EVIDENCE_TIMEOUT_MS, ctx.timeoutMs),
		...(ctx.signal ? { signal: ctx.signal } : {}),
	});
	return evidence === "alive";
}

async function settleRun(s: SpawnedRun, ctx: RunContext): Promise<RunResult> {
	if (s.error) {
		return await failedLaunchResult(s, ctx);
	}
	const report = (ok: boolean) =>
		ctx.onStatus?.(s.req.index, { state: ok ? "done" : "failed", paneId: s.paneId, outputPath: s.outputPath });

	// Liveness: a blocking herdr wait resolves when the agent finishes its turn
	// (idle after working) or its pane is terminated. This races the output-file
	// check so we stop promptly instead of blocking for the full timeout. The
	// AbortController tears down the lingering `herdr wait` once the run settles.
	const paneId = s.paneId;
	const ac = new AbortController();
	// Re-armable: an idle report is not a turn boundary, so a false idle (a quiet
	// pane between a tool result and the next model stream) starts another wait
	// instead of ending the run.
	const armAgentWait = paneId
		? () => waitForAgentFinish(herdr.statusProbe(paneId), ctx.timeoutMs, { signal: ac.signal })
		: undefined;

	let outcome: RunOutcome;
	try {
		// The child writes its transcript live at sessionPath; the run is done when
		// the agent goes idle AND that transcript ends on a terminal assistant
		// message.
		outcome = await waitForRunCompletion(s.sessionPath, {
			timeoutMs: ctx.timeoutMs,
			...(armAgentWait ? { agentSignal: armAgentWait(), rearmAgentSignal: armAgentWait } : {}),
			isTurnComplete: () => hasTerminalAssistantMessage(s.sessionPath),
		});
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
	const failure = resolved.ok ? undefined : [outcomeError(outcome), whereToLook(s)].filter(Boolean).join("; ");
	return {
		...baseResult(s.req, resolved, failure, outcomeFailure(outcome)),
		backend: "herdr",
		paneId: s.paneId,
	};
}

/**
 * Settle a run whose launch failed — without throwing its transcript away.
 *
 * A launch-side error does not mean nothing ran: the child may have been working
 * for minutes when herdr's call failed. Reading the transcript here is what
 * turns a discarded run into a reported one. It still counts as failed (nobody
 * observed the turn end), but the text is preserved and the error names the pane
 * and the transcript so the next diagnosis is one look rather than a night of
 * bisecting.
 */
async function failedLaunchResult(s: SpawnedRun, ctx: RunContext): Promise<RunResult> {
	const resolved = await resolveRunOutput(s.outputPath, s.sessionPath, {
		fallback: () => s.scrollback ?? (s.paneId ? herdr.readPane(s.paneId) : undefined),
		finishedCleanly: false,
		placeholder: `(failed to run in herdr: ${s.error})`,
	});
	ctx.onStatus?.(s.req.index, { state: "failed", paneId: s.paneId, outputPath: s.outputPath });
	return {
		...baseResult(s.req, resolved, [s.error, whereToLook(s)].filter(Boolean).join("; "), "launch"),
		backend: "herdr",
		...(s.paneId ? { paneId: s.paneId } : {}),
	};
}

/** Where to look when a run failed: the pane, the transcript, and its state. */
function whereToLook(s: SpawnedRun): string {
	return [s.paneId ? `pane ${s.paneId}` : undefined, `transcript ${s.sessionPath}`, describeTranscript(s.sessionPath)]
		.filter((v): v is string => !!v)
		.join(", ");
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
		// No tab, no pane, or no child: nothing about the task was ever tried.
		failure: "launch",
	};
}

/** The failure class a completion outcome amounts to. */
function outcomeFailure(outcome: RunOutcome): RunFailure {
	switch (outcome) {
		case "timeout":
			return "timeout";
		case "gone":
			// The pane was terminated: by the user, or by the batch being cancelled.
			return "cancelled";
		default:
			// The child finished (or its transcript settled) with nothing usable.
			return "run";
	}
}
