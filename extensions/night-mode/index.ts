/**
 * night-mode
 *
 * Overnight babysitting for long agent runs.
 *
 * Between 21:00 and 09:00 local:
 *  1. holds a wake lock (Amphetamine session, or `caffeinate` when Amphetamine
 *     is not installed) while an agent run is in flight (or while paused waiting
 *     for a reset) so the machine never sleeps mid-run,
 *  2. watches the Claude 5h subscription window (published by the `usage`
 *     extension on the event bus) and pauses the agent at 95% so the session
 *     never spills past the limit,
 *  3. records the pause in the session, then auto-sends a "continue" prompt
 *     once the window has reset.
 *
 * Pausing works by blocking every tool call in the current batch with
 * `terminate: true`, which ends the agent loop at a clean boundary. Nothing is
 * dropped: the transcript keeps everything and the resume prompt picks it up.
 *
 * State is per session, per pi instance. Emits `night-mode:state` on the bus.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	FIVE_HOUR_LABEL,
	findWindow,
	isUsageSnapshotEvent,
	USAGE_REQUEST_EVENT,
	USAGE_SNAPSHOT_EVENT,
	type UsageSnapshot,
	WEEK_LABEL,
} from "../usage/protocol.ts";
import {
	formatDateTimeStamp,
	NEEDS_HUMAN_HEADING,
	type NightConfig,
	noteNameFor,
	readNightConfig,
	reportPathFor,
	resolvePath,
} from "./config.ts";
import {
	carryOver,
	type CarryOverResult,
	fingerprint,
	formatLedger,
	formatUnresolved,
	counts as ledgerCounts,
	ledgerDir as resolveLedgerDir,
	type LedgerItem,
	needsReview,
	readLedger,
	runIdFor,
	unresolved,
	verifyLedger,
} from "./ledger.ts";
import {
	computeResumeDelayMs,
	DEFAULT_THRESHOLD_PERCENT,
	DEFAULT_WEEKLY_THRESHOLD_PERCENT,
	DEFAULT_WINDOW,
	formatClock,
	formatDuration,
	formatWindow,
	isWithinWindow,
	type NightWindow,
	type PauseReason,
	pauseReasonFor,
	RESUME_RETRY_MS,
	shouldHoldCaffeinate,
	WEEKLY_RETRY_MS,
	windowStartingAt,
} from "./night-mode.ts";
import { clearActiveNightRun, type NightSandboxRequest, writeActiveNightRun } from "./night-run.ts";
import { SANDBOX_REQUEST_EVENT, type SandboxRequestEvent } from "../spindle/sandbox/protocol.ts";
import { agentWorkspacesRoot } from "./agent-workspace.ts";
import { createRunSandbox, prepareConfigHome, prepareWorkingCopy, sandboxPathFor } from "./sandbox-clone.ts";
import { WakeLock, type WakeLockPreference } from "./wake-lock.ts";
import {
	appendUnderHeading,
	composeCarryOver,
	composeLedgerReminder,
	composeNightPrompt,
	composeNudge,
	composeReportHeader,
	composeResumePrompt,
	hasInstructions,
	timelineLine,
} from "./prompt.ts";

const TICK_MS = 30_000;
const STATUS_KEY = "night-mode";
const PAUSE_ENTRY = "night-mode:pause";
const STATE_EVENT = "night-mode:state";

/** Hard cap on automated "you are not done" follow-ups in one night. */
const MAX_CONTINUATIONS = 10;

export interface NightModeState {
	enabled: boolean;
	inWindow: boolean;
	paused: boolean;
	/** Which subscription window caused the pause. */
	pauseReason?: PauseReason;
	/** Epoch ms of the scheduled resume attempt, when paused. */
	resumeAt?: number;
	usedPercent?: number;
	threshold: number;
	weekPercent?: number;
	weeklyThreshold: number;
	/** True while an agent run is in flight (between `agent_start` and `agent_settled`). */
	agentBusy: boolean;
	/** True while this session holds a wake lock. */
	caffeinated: boolean;
	/** Mechanism holding sleep off, `"off"` when nothing is held. */
	wakeLock: "amphetamine" | "caffeinate" | "off";
}

export default function (pi: ExtensionAPI): void {
	let ctxRef: ExtensionContext | undefined;
	let wakeLock: WakeLock | undefined;
	let usage: UsageSnapshot | undefined;
	let enabled = true;
	let inWindow = false;
	let paused = false;
	/** Which window caused the current pause. */
	let pausedReason: PauseReason | undefined;
	/** When the current pause started, for the resume prompt. */
	let pausedAt: Date | undefined;
	/** True between `agent_start` and `agent_settled`. */
	let agentBusy = false;
	let resumeAt: number | undefined;
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;
	let tickTimer: ReturnType<typeof setInterval> | undefined;
	let unsubscribeUsage: (() => void) | undefined;
	/** Session-only window override, set by `/night start`. */
	let windowOverride: NightWindow | undefined;

	const currentWindow = (): NightWindow => windowOverride ?? DEFAULT_WINDOW;

	const fiveHour = () => findWindow(usage, FIVE_HOUR_LABEL);
	const usedPercent = () => fiveHour()?.usedPercent;
	const week = () => findWindow(usage, WEEK_LABEL);
	const weekPercent = () => week()?.usedPercent;

	/** The window that should stop the run right now, weekly first. */
	const currentPauseReason = (): PauseReason | undefined =>
		pauseReasonFor({
			fiveHourPercent: usedPercent(),
			weekPercent: weekPercent(),
		});

	/** Usage reading behind a pause reason, for messages and the footer. */
	const percentFor = (reason: PauseReason | undefined): number | undefined =>
		reason === "week" ? weekPercent() : usedPercent();

	const thresholdFor = (reason: PauseReason | undefined): number =>
		reason === "week" ? DEFAULT_WEEKLY_THRESHOLD_PERCENT : DEFAULT_THRESHOLD_PERCENT;

	const limitLabel = (reason: PauseReason | undefined): string =>
		reason === "week" ? "weekly usage limit" : "5h usage window";

	// ── night run (prompt / instructions / report) ────────────────────────

	/** Set for the lifetime of a `/night start` run. */
	let run:
		| {
				config: NightConfig;
				reportPath: string;
				startedAt: Date;
				/** Todo store backing the ledger, resolved once at start. */
				ledgerDir: string;
				/** Identity tonight's ledger items carry, so carry-over can be scoped. */
				runId: string;
				/** Per-run working copy, when one was cloned for tonight. */
				workspacePath?: string;
				/** Automated continuations sent so far. */
				nudges: number;
				/** Ledger fingerprint at the last continuation, for stall detection. */
				lastFingerprint?: string;
		  }
		| undefined;
	/** Instructions file waiting to be archived once the agent settles. */
	let pendingInstructionsClear: string | undefined;
	/**
	 * `PI_TODO_PATH` as it was before the run pointed it at the night ledger.
	 * `undefined` means it was unset, which is not the same as empty.
	 */
	let previousTodoPath: string | undefined;

	/** Append a line to tonight's report, if there is one. Never throws. */
	function appendReport(text: string): void {
		if (!run) return;
		try {
			appendFileSync(run.reportPath, text, "utf-8");
		} catch {
			// The report is the agent's file; losing an extension line is not fatal.
		}
	}

	const noteTimeline = (text: string) => appendReport(timelineLine(new Date(), text));

	/**
	 * Hand a message to the agent, picking the delivery mode from the session's
	 * state.
	 *
	 * `deliverAs: "followUp"` appends to the turn currently in flight. Sending it
	 * while the session is idle queues it against a turn that will never run, so
	 * `/night start` typed at an idle prompt used to report success and then sit
	 * there forever. Idle means "start a turn", which is the default delivery.
	 */
	function deliver(message: string, ctx?: ExtensionContext): void {
		const context = ctx ?? ctxRef;
		const idle = context?.isIdle?.() ?? false;
		pi.sendUserMessage(message, idle ? undefined : { deliverAs: "followUp" });
	}

	/** Insert lines under a report heading. Never throws. */
	function noteUnderHeading(heading: string, text: string): void {
		if (!run) return;
		try {
			const body = readFileSync(run.reportPath, "utf-8");
			writeFileSync(run.reportPath, appendUnderHeading(body, heading, text), "utf-8");
		} catch {
			appendReport(`\n## ${heading}\n\n${text}\n`);
		}
	}

	/**
	 * Move the consumed instructions to the archive and truncate the original, so
	 * the next night does not replay tonight's asks. Done when the run ends rather
	 * than at inject time: a crash mid-run keeps the file intact.
	 */
	function consumeInstructions(): void {
		const path = pendingInstructionsClear;
		pendingInstructionsClear = undefined;
		if (!path || !run) return;
		try {
			const body = readFileSync(path, "utf-8");
			if (run.config.archiveDir) {
				const dir = resolvePath(run.config.archiveDir, dirname(path));
				mkdirSync(dir, { recursive: true });
				const name = `${formatDateTimeStamp(run.startedAt)} - Night Instructions.md`;
				writeFileSync(join(dir, name), body, "utf-8");
			}
			writeFileSync(path, "", "utf-8");
		} catch {
			// Leave the file alone if anything goes wrong; a replay beats a loss.
		}
	}

	/**
	 * Seed the (now empty) instructions file with what never got done, so the
	 * next night starts on the leftovers instead of losing them at sunrise.
	 */
	function seedCarryOver(carried: CarryOverResult): void {
		if (!run || carried.items.length === 0 || !run.config.instructionsPath) return;
		try {
			const path = resolvePath(run.config.instructionsPath, process.cwd());
			const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
			const block = composeCarryOver(run.startedAt, formatUnresolved(carried.items), run.reportPath);
			const separator = existing.trim() ? "\n\n" : "";
			writeFileSync(path, `${existing.replace(/\s*$/, "")}${separator}${block}`, "utf-8");
		} catch {
			// Carry-over is a convenience; the report still lists what is open.
		}
	}

	/**
	 * Tear down the night run: record what is still open in the report, hand it to
	 * the next night, retire tonight's instructions and drop the handshake.
	 */
	function endRun(reason: string): void {
		if (!run) return;
		const items = currentLedger();
		const open = unresolved(items);
		const tally = ledgerCounts(items);
		noteTimeline(
			`night-mode: run ended (${reason}) - ${tally.done} done, ${tally.skipped} skipped, ${open.length} open` +
				(tally.needsReview ? `, ${tally.needsReview} with evidence that failed verification` : ""),
		);
		const failed = needsReview(items);
		if (failed.length > 0) {
			noteUnderHeading(
				NEEDS_HUMAN_HEADING,
				"Closed with evidence that does not check out, so the claim was not believed:\n" +
					failed.map((item) => `- ${item.id} ${item.title}: ${item.verification?.detail ?? "unknown"}`).join("\n"),
			);
		}
		if (open.length > 0) {
			noteUnderHeading(
				NEEDS_HUMAN_HEADING,
				`Still open when the run ended (${reason}), carried over to the next night:\n${formatUnresolved(open)}`,
			);
		}
		consumeInstructions();
		const carried = carryOver(items, { currentRunId: run.runId });
		if (carried.duplicates.length > 0 || carried.stale.length > 0) {
			noteTimeline(
				`night-mode: carry-over scoped to run ${carried.fromRunId ?? "(untagged)"} - ` +
					`${carried.duplicates.length} duplicate(s) and ${carried.stale.length} item(s) from older runs dropped`,
			);
		}
		seedCarryOver(carried);
		// Hand the session's todo store back before dropping the handshake.
		if (previousTodoPath === undefined) delete process.env.PI_TODO_PATH;
		else process.env.PI_TODO_PATH = previousTodoPath;
		previousTodoPath = undefined;
		clearActiveNightRun();
		// Release the sandbox: the session goes back to whatever spindle.json says,
		// so an interactive morning is not stuck inside the night's policy.
		requestSandbox(null, "night run ended");
		run = undefined;
	}

	/**
	 * Tonight's ledger, with every `done` item's evidence checked.
	 *
	 * Read from disk on every call on purpose: subagents close their own items,
	 * so a cached snapshot is how a run ends up reporting work that landed two
	 * minutes ago as still open.
	 */
	function currentLedger(): LedgerItem[] {
		if (!run) return [];
		return verifyLedger(readLedger(run.ledgerDir), { cwd: run.workspacePath ?? process.cwd() });
	}

	/** One-line ledger tally for `/night status` and `/night report`. */
	function ledgerSummary(): string {
		if (!run) return "no run";
		const tally = ledgerCounts(currentLedger());
		if (tally.total === 0) return "empty (no todo tagged 'night' yet)";
		return (
			`${tally.total} item(s): ${tally.done} done, ${tally.skipped} skipped, ` +
			`${tally.pending} pending, ${tally.unverified} unverified, ${tally.needsReview} needs-review` +
			` (continuations ${run.nudges}/${MAX_CONTINUATIONS})`
		);
	}

	/**
	 * Called when the agent decides it is finished. The ledger, not the agent, is
	 * the authority: while it holds unresolved items, send an automated
	 * continuation instead of letting the night stop.
	 *
	 * Two brakes keep this from spinning: a hard cap on continuations, and a
	 * fingerprint check, since a nudge that changes nothing is a stall.
	 */
	function maybeContinue(): void {
		if (!run || !enabled || !inWindow || paused) return;

		const items = currentLedger();
		const open = unresolved(items);
		if (items.length > 0 && open.length === 0) {
			endRun("every ledger item resolved");
			return;
		}

		if (run.nudges >= MAX_CONTINUATIONS) {
			noteUnderHeading(
				NEEDS_HUMAN_HEADING,
				`night-mode gave up after ${MAX_CONTINUATIONS} automated continuations with work still open.`,
			);
			endRun("continuation cap reached");
			return;
		}

		const current = fingerprint(items);
		if (run.nudges > 0 && current === run.lastFingerprint) {
			noteUnderHeading(
				NEEDS_HUMAN_HEADING,
				"night-mode stopped: the last automated continuation changed nothing in the ledger, so the run is stuck.",
			);
			endRun("stalled, no progress since the last continuation");
			return;
		}

		run.lastFingerprint = current;
		run.nudges += 1;
		const message =
			items.length === 0
				? composeLedgerReminder(run.reportPath)
				: composeNudge({
						unresolved: formatUnresolved(open),
						reportPath: run.reportPath,
						attempt: run.nudges,
						maxAttempts: MAX_CONTINUATIONS,
					});
		noteTimeline(
			`night-mode: settled with ${open.length || "no"} ledger item(s) open, sending continuation ${run.nudges}/${MAX_CONTINUATIONS}`,
		);
		deliver(message);
	}

	/**
	 * Read the configured files, create the report, publish the handshake and
	 * hand the composed prompt to the agent. Returns an error string on failure.
	 */
	async function startRun(ctx: ExtensionContext, windowLabel: string): Promise<string | undefined> {
		const cwd = process.cwd();
		const config = readNightConfig(cwd);
		const promptPath = resolvePath(config.promptPath, cwd);
		if (!existsSync(promptPath)) return `night-mode: prompt file not found at ${promptPath}`;

		let prompt: string;
		try {
			prompt = readFileSync(promptPath, "utf-8");
		} catch (error) {
			return `night-mode: cannot read ${promptPath}: ${String(error)}`;
		}
		if (!prompt.trim()) return `night-mode: prompt file ${promptPath} is empty`;

		const instructionsPath = resolvePath(config.instructionsPath, cwd);
		let instructions = "";
		try {
			if (existsSync(instructionsPath)) instructions = readFileSync(instructionsPath, "utf-8");
		} catch {
			instructions = "";
		}

		const startedAt = new Date();
		const reportPath = reportPathFor(config, startedAt, cwd);
		try {
			mkdirSync(dirname(reportPath), { recursive: true });
			if (!existsSync(reportPath)) {
				writeFileSync(reportPath, composeReportHeader(startedAt, windowLabel, config.reportSections), "utf-8");
			}
		} catch (error) {
			return `night-mode: cannot create report at ${reportPath}: ${String(error)}`;
		}

		const sessionId = ctx.sessionManager?.getSessionId?.();
		// Awaited: cloning a real repository takes seconds, and doing it
		// synchronously would freeze the UI for the whole copy.
		const prepared = await prepareWorkspace(config, cwd, startedAt, ctx);
		const workspace = prepared.path;
		// Set on this process, so every shell and every subagent `pi` the run spawns
		// inherits it: without it the first jj command in the clone fails with
		// "Failed to determine the secure config for a repo", and no child can commit.
		if (prepared.configHome) process.env.XDG_CONFIG_HOME = prepared.configHome;
		// Created up front: the todo tool writes into a store, it does not create the
		// dedicated directory the run points it at, and a missing one would make the
		// first ledger write fail at 2am.
		const ledgerPath = resolveLedgerDir(config, cwd);
		try {
			mkdirSync(ledgerPath, { recursive: true });
		} catch (error) {
			return `night-mode: cannot create ledger store at ${ledgerPath}: ${String(error)}`;
		}
		// Set on this process, like XDG_CONFIG_HOME below: this is what makes the
		// coordinator's own todo tool write the ledger to the night store, and every
		// child spawned from here inherits it. Restored when the run ends, so a
		// morning `/todos` is back on the project's own store.
		previousTodoPath = process.env.PI_TODO_PATH;
		process.env.PI_TODO_PATH = ledgerPath;

		const sandbox = composeSandboxRequest({
			config,
			workspacePath: workspace,
			cwd,
			reportPath,
			ledgerDir: ledgerPath,
		});
		run = {
			config,
			reportPath,
			startedAt,
			ledgerDir: ledgerPath,
			runId: runIdFor(startedAt),
			nudges: 0,
			...(workspace ? { workspacePath: workspace } : {}),
		};
		pendingInstructionsClear = hasInstructions(instructions) ? instructionsPath : undefined;

		// Written before the request is emitted: subagent processes read the policy
		// from this file, so it has to be on disk before any child can start.
		writeActiveNightRun({
			startedAt: startedAt.getTime(),
			reportPath,
			maxPullRequests: config.maxPullRequests,
			ledgerDir: ledgerPath,
			...(sessionId ? { sessionId } : {}),
			...(workspace ? { workspacePath: workspace } : {}),
			...(sandbox ? { sandbox } : {}),
			// Read-only MCP for the night, written before any child can start: a
			// subagent reads the guardrail from this file, so it has to be on disk
			// first (same reason as the sandbox above).
			...(config.mcpReadOnly ? { mcp: { readOnly: true } } : {}),
		});
		if (sandbox) requestSandbox(sandbox, "night run started");

		noteTimeline(`night-mode: run started, window ${windowLabel}`);
		if (workspace) noteTimeline(`night-mode: working copy ${workspace}`);
		// Reported here rather than inside prepareWorkspace: the report only exists
		// once `run` is set, so an earlier note would be dropped.
		for (const note of prepared.notes) noteTimeline(`night-mode: ${note}`);
		if (prepared.problems.length > 0) {
			noteUnderHeading(
				NEEDS_HUMAN_HEADING,
				`Working copy caveats:\n${prepared.problems.map((problem) => `- ${problem}`).join("\n")}`,
			);
		}
		if (sandbox)
			noteTimeline(
				`night-mode: sandbox ${sandbox.mode}, writable: ${(sandbox.allowWrite ?? []).join(", ") || "(defaults)"}`,
			);
		if (config.mcpReadOnly) noteTimeline("night-mode: MCP write tools refused for the night (read-only MCP mode)");
		deliver(
			composeNightPrompt({
				prompt,
				instructions,
				reportPath,
				maxPullRequests: config.maxPullRequests,
				windowLabel,
				startedAt,
				...(workspace ? { workspacePath: workspace } : {}),
			}),
			ctx,
		);
		return undefined;
	}

	/**
	 * Ask Spindle to sandbox the filesystem for the duration of the run.
	 *
	 * The writable set is derived from the run itself rather than configured: the
	 * working copy the agent was told to use, the report it has to append to, and
	 * the todo store backing the ledger. Anything else on the disk is read-only for
	 * the night, which is the whole point.
	 *
	 * Returns undefined when the config disables it, so `nightMode.sandboxMode:
	 * "off"` restores the previous behaviour exactly.
	 */
	function composeSandboxRequest(input: {
		config: NightConfig;
		workspacePath: string | undefined;
		cwd: string;
		reportPath: string;
		ledgerDir: string;
	}): NightSandboxRequest | undefined {
		const mode = input.config.sandboxMode;
		if (mode === "off") return undefined;
		return {
			mode,
			allowWrite: [
				input.workspacePath ?? input.cwd,
				// Where each subagent's own jj workspace is created, once the run
				// starts delegating. Granted up front because the policy is written
				// once, at start, and child processes read it from that file.
				...(input.workspacePath ? [agentWorkspacesRoot(input.workspacePath)] : []),
				dirname(input.reportPath),
				input.ledgerDir,
				// Roots the run cannot derive: a second repository the night is
				// expected to touch, a notes vault, and so on.
				...input.config.sandboxAllowWrite.map((path) => resolvePath(path, input.cwd)),
			],
			// Egress, unlike the writable set, is a widening: see the comment on
			// `NightSandboxRequest.network`.
			...(input.config.sandboxAllowedDomains.length
				? { network: { allowedDomains: input.config.sandboxAllowedDomains } }
				: {}),
		};
	}

	/** Publish a sandbox request on the bus. No listener means no spindle: harmless. */
	function requestSandbox(policy: NightSandboxRequest | null, reason: string): void {
		const event: SandboxRequestEvent = { policy, reason };
		pi.events.emit(SANDBOX_REQUEST_EVENT, event);
	}

	/**
	 * Clone the session's checkout into a private working copy for tonight, so an
	 * unattended run cannot dirty, stash or reset the tree the user left open.
	 *
	 * Returns undefined when cloning is disabled or fails. A failed clone degrades
	 * to "work in the real checkout" with a warning rather than blocking the run:
	 * the night still has value, it just loses one layer of containment.
	 */
	async function prepareWorkspace(
		config: NightConfig,
		cwd: string,
		startedAt: Date,
		ctx: ExtensionContext,
	): Promise<{ path?: string; configHome?: string; notes: string[]; problems: string[] }> {
		if (!config.sandboxRoot) return { notes: [], problems: [] };
		try {
			const root = resolvePath(config.sandboxRoot, cwd);
			const destination = sandboxPathFor(root, cwd, formatDateTimeStamp(startedAt));
			ctx.ui.notify(`night-mode: copying ${cwd} into a private working copy, this can take a moment...`, "info");
			const created = await createRunSandbox({
				source: cwd,
				destination,
				copyFiles: config.sandboxCopyFiles,
			});
			if (created.fallbacks.length > 0) {
				ctx.ui.notify(
					`night-mode: cloned with '${created.strategy}' after ${created.fallbacks.join("; ")}`,
					"info",
				);
			}

			// mise and direnv trust by path, so a fresh copy is untrusted and every
			// `mise` command in it would hard-fail. Done here, in the host process:
			// the trust stores sit outside the run's writable roots.
			const trusted = await prepareWorkingCopy(created.path, {
				trust: config.sandboxTrust,
			});
			if (trusted.problems.length > 0) {
				ctx.ui.notify(`night-mode: working copy caveats - ${trusted.problems.join("; ")}`, "warning");
			}
			// jj writes a per-repository record under its config dir, which is not
			// writable during a run, so the run gets its own copy of it. Placed under
			// the workspaces root, which is already in the sandbox's writable set.
			const configHome = prepareConfigHome(join(agentWorkspacesRoot(created.path), "xdg"));
			return {
				path: created.path,
				...(configHome.path ? { configHome: configHome.path } : {}),
				notes: [
					...(trusted.ran.length ? [`working copy prepared (${trusted.ran.join(", ")})`] : []),
					...(configHome.path ? [`config home ${configHome.path} (jj writes its per-repo record there)`] : []),
				],
				problems: [...trusted.problems, ...configHome.problems],
			};
		} catch (error) {
			ctx.ui.notify(
				`night-mode: no private working copy tonight (${String(error)}). The run will use ${cwd}.`,
				"warning",
			);
			return {
				notes: [],
				problems: [`no private working copy: ${String(error)}`],
			};
		}
	}

	// ── wake lock ─────────────────────────────────────────────────────────

	/**
	 * The lock is built on first use rather than at load time: resolving the
	 * backend reads settings and stats the Amphetamine bundle, and neither is
	 * worth doing in a session that never enters the night window.
	 */
	function lock(): WakeLock {
		if (!wakeLock) {
			let preference: WakeLockPreference = "auto";
			try {
				preference = readNightConfig(process.cwd()).wakeLock;
			} catch {
				// settings unreadable, keep the default
			}
			wakeLock = new WakeLock(preference, {
				warn: (message) => ctxRef?.ui.notify(message, "warning"),
			});
		}
		return wakeLock;
	}

	function startCaffeinate(): void {
		void lock().acquire();
	}

	function stopCaffeinate(): void {
		void lock().release();
	}

	// ── state reporting ───────────────────────────────────────────────────

	function snapshotState(): NightModeState {
		const held = lock().status();
		return {
			enabled,
			inWindow,
			paused,
			pauseReason: pausedReason,
			resumeAt,
			usedPercent: usedPercent(),
			threshold: DEFAULT_THRESHOLD_PERCENT,
			weekPercent: weekPercent(),
			weeklyThreshold: DEFAULT_WEEKLY_THRESHOLD_PERCENT,
			agentBusy,
			caffeinated: held.held,
			wakeLock: held.backend === "none" ? "off" : held.backend,
		};
	}

	/** `amphetamine (holding, 27m left)` / `caffeinate (off)`. */
	function wakeLockLine(): string {
		const state = lock().status();
		const left = state.expiresAt !== undefined ? `, ${formatDuration(state.expiresAt - Date.now())} left` : "";
		if (state.configured === "none") return "off (unsupported or disabled)";
		return `${state.configured} (${state.held ? `holding${left}` : "idle"})`;
	}

	function statusText(): string | undefined {
		if (!enabled || !inWindow) return undefined;
		if (paused) {
			const left = resumeAt ? formatDuration(resumeAt - Date.now()) : "?";
			const label = pausedReason === "week" ? "week" : "5h";
			return `\u{1F319} paused (${label} ${Math.round(percentFor(pausedReason) ?? 100)}%) \u27F3 ${left}`;
		}
		const pct = usedPercent();
		return pct === undefined ? "\u{1F319} night" : `\u{1F319} night (5h ${Math.round(pct)}%)`;
	}

	function report(): void {
		ctxRef?.ui.setStatus(STATUS_KEY, statusText());
		pi.events.emit(STATE_EVENT, snapshotState());
	}

	// ── pause / resume ────────────────────────────────────────────────────

	function clearResumeTimer(): void {
		if (resumeTimer) {
			clearTimeout(resumeTimer);
			resumeTimer = undefined;
		}
	}

	function armResume(delayMs: number): void {
		clearResumeTimer();
		resumeAt = Date.now() + delayMs;
		resumeTimer = setTimeout(() => void resume(), delayMs);
		resumeTimer.unref?.();
	}

	/**
	 * The 5h window is the only one the provider gives a reset for, so a weekly
	 * pause cannot schedule anything: it polls the snapshot on a coarse interval
	 * until the week rolls over.
	 */
	function scheduleResume(): void {
		if (pausedReason === "week") {
			armResume(WEEKLY_RETRY_MS);
			return;
		}
		armResume(computeResumeDelayMs(fiveHour()?.resetsAt, Date.now()));
	}

	function pause(reason: PauseReason): void {
		if (paused) return;
		paused = true;
		pausedReason = reason;
		pausedAt = new Date();
		scheduleResume();
		const pct = Math.round(percentFor(reason) ?? 100);
		pi.appendEntry(PAUSE_ENTRY, {
			status: "paused",
			reason,
			at: pausedAt.toISOString(),
			usedPercent: percentFor(reason),
			resetsAt: reason === "week" ? undefined : fiveHour()?.resetsAt,
			resumeAt,
		});
		report();
		noteTimeline(
			`⏸ paused: Claude ${limitLabel(reason)} at ${pct}%` +
				(reason === "week"
					? ", waiting for the week to roll over"
					: resumeAt
						? `, resuming around ${formatClock(new Date(resumeAt))}`
						: ""),
		);
		ctxRef?.ui.notify(
			`night-mode: Claude ${limitLabel(reason)} at ${pct}%, pausing` +
				(reason === "week"
					? " until the weekly window has room again"
					: resumeAt
						? ` until ${formatClock(new Date(resumeAt))}`
						: ""),
			"warning",
		);
	}

	function clearPause(): void {
		if (!paused) return;
		paused = false;
		pausedReason = undefined;
		pausedAt = undefined;
		resumeAt = undefined;
		clearResumeTimer();
		report();
	}

	async function resume(): Promise<void> {
		resumeTimer = undefined;
		if (!paused) return;

		// Ask for a fresh reading before trusting the reset.
		pi.events.emit(USAGE_REQUEST_EVENT, { reason: "night-mode-resume" });
		const still = currentPauseReason();
		if (still) {
			// A 5h pause can turn into a weekly one while it waits, and the retry
			// cadence differs, so re-read the reason instead of keeping the old one.
			pausedReason = still;
			armResume(still === "week" ? WEEKLY_RETRY_MS : RESUME_RETRY_MS);
			report();
			return;
		}

		const reason = pausedReason ?? "5h";
		const since = pausedAt;
		paused = false;
		pausedReason = undefined;
		pausedAt = undefined;
		resumeAt = undefined;
		clearResumeTimer();
		pi.appendEntry(PAUSE_ENTRY, {
			status: "resumed",
			reason,
			at: new Date().toISOString(),
			usedPercent: percentFor(reason),
		});
		report();
		noteTimeline(reason === "week" ? "▶ resumed: weekly usage limit has room again" : "▶ resumed: 5h window reset");
		ctxRef?.ui.notify(`night-mode: ${limitLabel(reason)} has room again, sending automated continue`, "info");
		deliver(
			composeResumePrompt({
				reason,
				now: new Date(),
				...(since ? { pausedAt: since } : {}),
			}),
		);
	}

	// ── evaluation ────────────────────────────────────────────────────────

	/**
	 * Take or release the wake lock to match the current state. Called from every
	 * `evaluate`, which is also what re-arms a bounded Amphetamine session.
	 */
	function syncWakeLock(): void {
		if (shouldHoldCaffeinate({ enabled, inWindow, agentBusy, paused })) startCaffeinate();
		else stopCaffeinate();
	}

	function evaluate(): void {
		const active = enabled && isWithinWindow(new Date(), currentWindow());
		if (active !== inWindow) {
			inWindow = active;
			if (!active) {
				clearPause();
				endRun("window closed");
			}
		}
		if (inWindow && !paused) {
			const reason = currentPauseReason();
			if (reason) pause(reason);
		}
		syncWakeLock();
		report();
	}

	/** Re-arm a pause recorded before a `/reload` or session resume. */
	function restore(ctx: ExtensionContext): void {
		try {
			const entries = ctx.sessionManager.getEntries() as Array<{
				customType?: string;
				data?: unknown;
			}>;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry?.customType !== PAUSE_ENTRY) continue;
				const data = entry.data as { status?: string; resumeAt?: number; reason?: string; at?: string } | undefined;
				if (data?.status === "paused") {
					paused = true;
					pausedReason = data.reason === "week" ? "week" : "5h";
					const at = data.at ? new Date(data.at) : undefined;
					pausedAt = at && !Number.isNaN(at.getTime()) ? at : undefined;
					armResume(Math.max(0, (data.resumeAt ?? Date.now()) - Date.now()));
				}
				return;
			}
		} catch {
			// no session history available
		}
	}

	// ── wiring ───────────────────────────────────────────────────────────

	unsubscribeUsage = pi.events.on(USAGE_SNAPSHOT_EVENT, (data) => {
		if (!isUsageSnapshotEvent(data)) return;
		usage = data.snapshot;
		evaluate();
	});

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		restore(ctx);
		pi.events.emit(USAGE_REQUEST_EVENT, { reason: "night-mode-start" });
		if (!tickTimer) {
			tickTimer = setInterval(() => evaluate(), TICK_MS);
			tickTimer.unref?.();
		}
		evaluate();
	});

	pi.on("agent_start", () => {
		agentBusy = true;
		evaluate();
	});

	// `agent_settled` (not `agent_end`) is the real "nothing left to do" signal: no
	// retry, compaction or queued continuation will follow.
	pi.on("agent_settled", () => {
		agentBusy = false;
		evaluate();
		// The agent thinks it is done. The ledger decides whether it really is.
		maybeContinue();
	});

	pi.on("tool_call", (_event, ctx) => {
		ctxRef = ctx;
		if (!enabled || !inWindow || !paused) return;
		const until =
			pausedReason === "week"
				? "the weekly window has room again"
				: resumeAt
					? formatClock(new Date(resumeAt))
					: "the next window";
		return {
			block: true,
			terminate: true,
			reason:
				`night-mode: Claude ${limitLabel(pausedReason)} at ${Math.round(percentFor(pausedReason) ?? 100)}% ` +
				`(limit ${thresholdFor(pausedReason)}%). Stopping here until ${until}, ` +
				"when an automated continue will be sent. Do not retry.",
		};
	});

	pi.on("session_shutdown", async () => {
		endRun("session shutdown");
		lock().releaseSync();
		clearResumeTimer();
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = undefined;
		}
		unsubscribeUsage?.();
		unsubscribeUsage = undefined;
	});

	pi.registerCommand("night", {
		description:
			"Night mode: wake lock + Claude 5h budget guard (status | start | report | todos | on | off | resume)",
		getArgumentCompletions: (prefix) =>
			["status", "start", "report", "todos", "on", "off", "resume"]
				.filter((v) => v.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const action = args.trim().toLowerCase();

			if (action === "start") {
				enabled = true;
				windowOverride = windowStartingAt(new Date());
				evaluate();
				const error = await startRun(ctx, formatWindow(currentWindow()));
				if (error) {
					ctx.ui.notify(error, "error");
					return;
				}
				ctx.ui.notify(
					[
						`night-mode: started, window ${formatWindow(currentWindow())} for this session`,
						`report: ${run?.reportPath}`,
						`working copy: ${run?.workspacePath ?? "session checkout (cloning disabled or failed)"}`,
						`instructions: ${pendingInstructionsClear ? "loaded, cleared when the run ends" : "none tonight"}`,
						`ledger: todos tagged 'night' in ${run?.ledgerDir}`,
					].join("\n"),
					"info",
				);
				return;
			}

			if (action === "report") {
				if (!run) {
					ctx.ui.notify("night-mode: no run in flight, no report for this session", "info");
					return;
				}
				let body = "";
				try {
					body = readFileSync(run.reportPath, "utf-8");
				} catch {
					body = "";
				}
				ctx.ui.notify(
					[
						`night-mode report: ${run.reportPath}`,
						`note: [[${noteNameFor(run.reportPath)}]]`,
						`size: ${body.length} chars, started ${formatDateTimeStamp(run.startedAt)}`,
						ledgerSummary(),
					].join("\n"),
					"info",
				);
				return;
			}

			if (action === "todos") {
				// Deliberately works with no run in flight, unlike the other subcommands:
				// reading the ledger is how you queue work for tonight, and the store is
				// configured rather than derived from the run.
				const cwd = process.cwd();
				const dir = run?.ledgerDir ?? resolveLedgerDir(readNightConfig(cwd), cwd);
				// Listing is for queueing work, not judging it, so `command` evidence is
				// reported unchecked here rather than blocking the TUI on a test suite.
				const items = verifyLedger(readLedger(dir), {
					cwd: run?.workspacePath ?? cwd,
					runCommands: false,
				});
				const tally = ledgerCounts(items);
				ctx.ui.notify(
					[
						`night-mode ledger: ${dir}`,
						run
							? ledgerSummary()
							: `${tally.total} item(s): ${tally.done} done, ${tally.skipped} skipped, ` +
								`${tally.pending} pending, ${tally.unverified} unverified (no run in flight)`,
						...(items.length > 0 ? ["", formatLedger(items)] : []),
					].join("\n"),
					"info",
				);
				return;
			}

			if (action === "on" || action === "off") {
				enabled = action === "on";
				if (!enabled) {
					endRun("turned off");
					stopCaffeinate();
					clearPause();
					inWindow = false;
					windowOverride = undefined;
				}
				evaluate();
				ctx.ui.notify(`night-mode: ${enabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (action === "resume") {
				if (!paused) {
					ctx.ui.notify("night-mode: not paused", "info");
					return;
				}
				const reason = pausedReason ?? "5h";
				const since = pausedAt;
				clearPause();
				deliver(
					composeResumePrompt({
						reason,
						now: new Date(),
						...(since ? { pausedAt: since } : {}),
					}),
					ctx,
				);
				return;
			}

			const pct = usedPercent();
			const weekly = weekPercent();
			const resets = fiveHour()?.resetsAt;
			const lines = [
				`night-mode: ${enabled ? "enabled" : "disabled"}`,
				`window: ${formatWindow(currentWindow())} (${inWindow ? "inside" : "outside"}${windowOverride ? ", session override" : ""})`,
				`wake lock: ${wakeLockLine()}`,
				`5h usage: ${pct === undefined ? "unknown" : `${Math.round(pct)}% / ${DEFAULT_THRESHOLD_PERCENT}%`}`,
				`5h reset: ${resets ? formatDuration(new Date(resets).getTime() - Date.now()) : "unknown"}`,
				`week usage: ${weekly === undefined ? "unknown" : `${Math.round(weekly)}% / ${DEFAULT_WEEKLY_THRESHOLD_PERCENT}%`}`,
				`paused: ${paused ? `yes (${limitLabel(pausedReason)}), resume in ${resumeAt ? formatDuration(resumeAt - Date.now()) : "?"}` : "no"}`,
				`run: ${run ? `since ${formatDateTimeStamp(run.startedAt)}, report ${run.reportPath}` : "none"}`,
				`working copy: ${run?.workspacePath ?? (run ? "session checkout (no clone)" : "n/a")}`,
				`ledger: ${ledgerSummary()}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
