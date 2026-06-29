/**
 * pr
 *
 * PR helper commands built around the PR for the current jj bookmark.
 *
 *   /review-comments  One-shot pull of unresolved code-review comments. Fetches
 *                     the PR's inline review threads (code comments only, no
 *                     general issue comments), drops resolved threads, lets you
 *                     multi-select which to address, then hands them to the agent.
 *
 *   /autofix            Background CI babysitter. Polls the PR's checks. While the
 *                     agent is working it only shows a footer status; it never
 *                     interrupts. When the agent is idle and CI is failing it
 *                     sends a fix request to the agent. Stops on its own once CI
 *                     is green.
 *
 *   /autofix-stop       Stop the background CI watcher.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const STATUS_KEY = "autofix";
const WIDGET_KEY = "autofix-checks";
const POLL_INTERVAL_MS = 10_000;
const NO_CHECKS_RETRIES = 6; // ~1 min of "no checks reported yet" before giving up

interface Check {
	name: string;
	bucket: string; // pass | fail | pending | skipping | cancel
	state: string; // SUCCESS | FAILURE | IN_PROGRESS | QUEUED | PENDING | ...
	link: string;
	workflow: string;
}

interface Comment {
	id: number;
	user: string;
	path?: string;
	line?: number;
	body: string;
	url: string;
}

interface PrInfo {
	bookmark: string;
	number: number;
	url: string;
	nwo: string; // owner/repo
}

// ---------------------------------------------------------------------------
// shell helpers
// ---------------------------------------------------------------------------

async function sh(pi: ExtensionAPI, cmd: string, args: string[]) {
	return pi.exec(cmd, args);
}

async function resolvePr(pi: ExtensionAPI): Promise<PrInfo> {
	const bm = await sh(pi, "jj", [
		"log",
		"-r",
		"heads(::@ & bookmarks())",
		"-T",
		"bookmarks",
		"--no-graph",
		"--ignore-working-copy",
		"--color",
		"never",
	]);
	const bookmark = bm.stdout.trim().split(/\s+/)[0]?.replace(/\*$/, "");
	if (!bookmark) {
		throw new Error("No bookmark found for the current change (heads(::@ & bookmarks()) is empty).");
	}

	const prRes = await sh(pi, "gh", ["pr", "view", bookmark, "--json", "number,url,state,headRefName"]);
	if (prRes.code !== 0) {
		throw new Error(`No PR found for bookmark '${bookmark}': ${prRes.stderr.trim() || prRes.stdout.trim()}`);
	}
	const pr = JSON.parse(prRes.stdout) as { number: number; url: string; state: string };

	const repoRes = await sh(pi, "gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
	const nwo = repoRes.stdout.trim();
	if (!nwo) throw new Error("Could not resolve repository (gh repo view).");

	return { bookmark, number: pr.number, url: pr.url, nwo };
}

async function fetchChecks(pi: ExtensionAPI, bookmark: string): Promise<Check[] | null> {
	const res = await sh(pi, "gh", [
		"pr",
		"checks",
		bookmark,
		"--json",
		"name,state,bucket,link,workflow",
	]);
	if (!res.stdout.trim()) return null; // no checks reported yet
	try {
		return JSON.parse(res.stdout) as Check[];
	} catch {
		return null;
	}
}

function classify(checks: Check[]): "pass" | "fail" | "pending" {
	if (checks.some((c) => c.bucket === "pending")) return "pending";
	if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return "fail";
	return "pass";
}

/**
 * Fetch the root comment of every *unresolved* review thread on the PR. Review
 * threads are inline code comments; general/issue comments are intentionally
 * excluded. Resolved state is only available through the GraphQL API.
 */
async function fetchUnresolvedReviewComments(pi: ExtensionAPI, pr: PrInfo): Promise<Comment[]> {
	const [owner, repo] = pr.nwo.split("/");
	const query = `query($owner:String!,$repo:String!,$num:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$num){
      reviewThreads(first:100){
        nodes{
          isResolved
          comments(first:1){
            nodes{ databaseId author{login} path line originalLine body url }
          }
        }
      }
    }
  }
}`;

	const res = await sh(pi, "gh", [
		"api",
		"graphql",
		"-f",
		`query=${query}`,
		"-F",
		`owner=${owner}`,
		"-F",
		`repo=${repo}`,
		"-F",
		`num=${pr.number}`,
		"--jq",
		".data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | .comments.nodes[0] | {id: .databaseId, user: .author.login, path, line: (.line // .originalLine), body, url} | @json",
	]);
	if (res.code !== 0) {
		throw new Error(`Failed to fetch review comments: ${res.stderr.trim() || res.stdout.trim()}`);
	}

	const out: Comment[] = [];
	for (const line of res.stdout.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const o = JSON.parse(t) as any;
			if (typeof o.id !== "number") continue;
			out.push({
				id: o.id,
				user: o.user ?? "unknown",
				path: o.path ?? undefined,
				line: o.line ?? undefined,
				body: (o.body ?? "").trim(),
				url: o.url ?? "",
			});
		} catch {}
	}
	return out.filter((c) => c.body.length > 0);
}

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

function buildCiPrompt(pr: PrInfo, failed: Check[]): string {
	const lines = [`CI is failing on PR ${pr.url} (branch ${pr.bookmark}). These checks failed:`, ""];
	for (const c of failed) lines.push(`- ${c.name} [${c.state}] ${c.link}`);
	lines.push(
		"",
		"Investigate the failures (use the `gh` CLI, e.g. `gh run view --log-failed <run-id>`, or `gh api`), fix the root cause in the code, create a conventional commit with jj, and push so CI re-runs.",
	);
	return lines.join("\n");
}

function buildCommentsPrompt(pr: PrInfo, comments: Comment[]): string {
	const lines = [`Address these review comments on PR ${pr.url}:`, ""];
	comments.forEach((c, i) => {
		const loc = c.path ? `${c.path}${c.line ? `:${c.line}` : ""}` : "(general)";
		lines.push(`${i + 1}. [${loc}] (@${c.user}) ${c.body}`);
		if (c.url) lines.push(`   ${c.url}`);
	});
	lines.push("", "Make the necessary code changes and create a conventional commit with jj.");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// UI: comment multi-select (cancellable)
// ---------------------------------------------------------------------------

async function selectComments(ctx: ExtensionCommandContext, comments: Comment[]): Promise<Comment[] | null> {
	if (ctx.mode !== "tui") return comments; // non-interactive: take them all

	return ctx.ui.custom<Comment[] | null>((tui, theme, _kb, done) => {
		let index = 0;
		const selected = comments.map(() => true);
		let cachedLines: string[] | undefined;
		const refresh = () => {
			cachedLines = undefined;
			tui.requestRender();
		};

		const render = (width: number): string[] => {
			if (cachedLines) return cachedLines;
			const w = Math.max(1, width);
			const lines: string[] = [];
			const add = (prefix: string, text: string) => {
				const pw = visibleWidth(prefix);
				const wrapped = wrapTextWithAnsi(text, Math.max(1, w - pw));
				const cont = " ".repeat(pw);
				wrapped.forEach((ln, i) => lines.push(`${i === 0 ? prefix : cont}${ln}`));
			};

			lines.push(theme.fg("accent", "─".repeat(w)));
			add(" ", theme.fg("text", theme.bold(`Select review comments to address (${comments.length} unresolved)`)));
			lines.push("");

			comments.forEach((c, i) => {
				const cur = i === index;
				const box = selected[i] ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				const arrow = cur ? theme.fg("accent", ">") : " ";
				const loc = c.path ? `${c.path}${c.line ? `:${c.line}` : ""}` : "general";
				const head = `${arrow} ${box} ${theme.fg(cur ? "accent" : "text", `${loc}`)} ${theme.fg("muted", `@${c.user}`)}`;
				add("", head);
				const oneLine = c.body.replace(/\s+/g, " ").trim();
				add("       ", theme.fg("muted", oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine));
			});

			lines.push("");
			add(" ", theme.fg("dim", "↑↓ move • space toggle • a all/none • enter confirm • esc cancel"));
			lines.push(theme.fg("accent", "─".repeat(w)));
			cachedLines = lines;
			return lines;
		};

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput: (data: string) => {
				if (matchesKey(data, Key.up)) {
					index = Math.max(0, index - 1);
					refresh();
				} else if (matchesKey(data, Key.down)) {
					index = Math.min(comments.length - 1, index + 1);
					refresh();
				} else if (data === " ") {
					selected[index] = !selected[index];
					refresh();
				} else if (data === "a" || data === "A") {
					const allOn = selected.every(Boolean);
					selected.fill(!allOn);
					refresh();
				} else if (matchesKey(data, Key.enter)) {
					done(comments.filter((_, i) => selected[i]));
				} else if (matchesKey(data, Key.escape)) {
					done(null);
				}
			},
		};
	});
}

// ---------------------------------------------------------------------------
// UI: CI failure popup (only shown while the agent is idle)
// ---------------------------------------------------------------------------

function checkGlyph(c: Check, theme: any): string {
	if (c.bucket === "pass") return theme.fg("success", "✓");
	if (c.bucket === "fail") return theme.fg("error", "✗");
	if (c.bucket === "cancel") return theme.fg("warning", "⊘");
	if (c.bucket === "skipping") return theme.fg("dim", "−");
	const running = /IN_PROGRESS|RUNNING/i.test(c.state);
	return running ? theme.fg("accent", "◐") : theme.fg("muted", "○");
}

function checkStateLabel(c: Check): string {
	if (c.bucket === "pending") return /IN_PROGRESS|RUNNING/i.test(c.state) ? "running" : "waiting";
	return c.bucket;
}

const BUCKET_RANK: Record<string, number> = { pending: 0, fail: 1, cancel: 2, skipping: 3, pass: 4 };

/** Render the CI checks as widget lines so the user can follow progress while idle. */
function renderChecksWidget(pr: PrInfo, checks: Check[], theme: any): string[] {
	const counts = {
		running: checks.filter((c) => c.bucket === "pending" && /IN_PROGRESS|RUNNING/i.test(c.state)).length,
		waiting: checks.filter((c) => c.bucket === "pending" && !/IN_PROGRESS|RUNNING/i.test(c.state)).length,
		pass: checks.filter((c) => c.bucket === "pass").length,
		fail: checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel").length,
	};
	const lines: string[] = [];
	lines.push(
		`${theme.fg("accent", "autofix")} ${theme.fg("dim", pr.bookmark)} ${theme.fg(
			"muted",
			`${counts.running} running • ${counts.waiting} waiting • ${counts.pass} passed • ${counts.fail} failed`,
		)}`,
	);
	const sorted = [...checks].sort(
		(a, b) => (BUCKET_RANK[a.bucket] ?? 9) - (BUCKET_RANK[b.bucket] ?? 9) || a.name.localeCompare(b.name),
	);
	for (const c of sorted) {
		lines.push(`${checkGlyph(c, theme)} ${theme.fg("text", c.name)} ${theme.fg("dim", `(${checkStateLabel(c)})`)}`);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// background CI watcher
// ---------------------------------------------------------------------------

interface Watcher {
	stopped: boolean;
}

let activeWatcher: Watcher | null = null;

async function interruptibleSleep(ms: number, watcher: Watcher): Promise<void> {
	const step = 500;
	let elapsed = 0;
	while (elapsed < ms && !watcher.stopped) {
		await new Promise((r) => setTimeout(r, Math.min(step, ms - elapsed)));
		elapsed += step;
	}
}

async function runCiWatch(pi: ExtensionAPI, ctx: ExtensionCommandContext, pr: PrInfo, watcher: Watcher): Promise<void> {
	const theme = ctx.ui.theme;
	const setStatus = (text: string) => ctx.ui.setStatus(STATUS_KEY, text);
	// Show the checks widget only while the agent is idle so the user can follow
	// CI progress; hide it while the agent is working (footer status takes over).
	const showWidget = (checks: Check[] | null) => {
		if (checks && checks.length > 0 && ctx.isIdle()) {
			ctx.ui.setWidget(WIDGET_KEY, renderChecksWidget(pr, checks, theme));
		} else {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	};
	let lastReportedKey: string | null = null;
	let noChecks = 0;

	try {
		while (!watcher.stopped) {
			const checks = await fetchChecks(pi, pr.bookmark);
			if (watcher.stopped) break;
			showWidget(checks);

			if (!checks) {
				noChecks++;
				setStatus(theme.fg("muted", `autofix: waiting for checks (${noChecks}/${NO_CHECKS_RETRIES})`));
				if (noChecks > NO_CHECKS_RETRIES) {
					ctx.ui.notify("autofix: no checks reported, stopping", "warning");
					break;
				}
				await interruptibleSleep(POLL_INTERVAL_MS, watcher);
				continue;
			}
			noChecks = 0;

			const status = classify(checks);
			if (status === "pending") {
				lastReportedKey = null;
				const running = checks.filter((c) => c.bucket === "pending").length;
				setStatus(theme.fg("accent", `autofix: ◐ watching CI (${running} pending)`));
				await interruptibleSleep(POLL_INTERVAL_MS, watcher);
				continue;
			}

			if (status === "pass") {
				ctx.ui.notify("autofix: CI green ✓ — done", "info");
				break;
			}

			// status === "fail"
			const failed = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
			const key = failed
				.map((c) => c.name)
				.sort()
				.join("|");

			if (!ctx.isIdle()) {
				setStatus(theme.fg("warning", `autofix: ✗ CI failing (${failed.length}) — will fix when idle`));
				await interruptibleSleep(POLL_INTERVAL_MS, watcher);
				continue;
			}

			if (key === lastReportedKey) {
				setStatus(theme.fg("warning", `autofix: ✗ reported, waiting for fix`));
				await interruptibleSleep(POLL_INTERVAL_MS, watcher);
				continue;
			}

			// idle + new failure: send the fix request directly to the agent.
			lastReportedKey = key;
			setStatus(theme.fg("warning", `autofix: ✗ reported failures, waiting for fix`));
			pi.sendUserMessage(buildCiPrompt(pr, failed));
			await ctx.waitForIdle();
			await interruptibleSleep(POLL_INTERVAL_MS, watcher);
		}
	} catch (e) {
		ctx.ui.notify(`autofix: ${(e as Error).message}`, "error");
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		if (activeWatcher === watcher) activeWatcher = null;
	}
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("review-comments", {
		description: "Pull unresolved code-review comments on the current PR and hand selected ones to the agent",
		handler: async (_args, ctx) => {
			let pr: PrInfo;
			try {
				pr = await resolvePr(pi);
			} catch (e) {
				ctx.ui.notify(`review-comments: ${(e as Error).message}`, "error");
				return;
			}

			let comments: Comment[];
			try {
				comments = await fetchUnresolvedReviewComments(pi, pr);
			} catch (e) {
				ctx.ui.notify(`review-comments: ${(e as Error).message}`, "error");
				return;
			}

			if (comments.length === 0) {
				ctx.ui.notify(`review-comments: no unresolved code-review comments on PR #${pr.number}`, "info");
				return;
			}

			const picked = await selectComments(ctx, comments);
			if (picked === null) {
				ctx.ui.notify("review-comments: cancelled", "warning");
				return;
			}
			if (picked.length === 0) {
				ctx.ui.notify("review-comments: nothing selected", "info");
				return;
			}

			ctx.ui.notify(`review-comments: handing ${picked.length} comment(s) to the agent`, "info");
			pi.sendUserMessage(buildCommentsPrompt(pr, picked));
		},
	});

	pi.registerCommand("autofix", {
		description: "Watch the current PR's CI in the background; send failures to the agent to auto-fix when idle",
		handler: async (_args, ctx) => {
			if (activeWatcher) {
				ctx.ui.notify("autofix: already watching (use /autofix-stop to stop)", "warning");
				return;
			}

			let pr: PrInfo;
			try {
				pr = await resolvePr(pi);
			} catch (e) {
				ctx.ui.notify(`autofix: ${(e as Error).message}`, "error");
				return;
			}

			const watcher: Watcher = { stopped: false };
			activeWatcher = watcher;
			ctx.ui.notify(`autofix: watching CI for PR #${pr.number} (${pr.bookmark})`, "info");
			// Detached loop: keep watching after the command returns.
			void runCiWatch(pi, ctx, pr, watcher);
		},
	});

	pi.registerCommand("autofix-stop", {
		description: "Stop the background autofix CI watcher",
		handler: async (_args, ctx) => {
			if (!activeWatcher) {
				ctx.ui.notify("autofix-stop: not watching", "info");
				return;
			}
			activeWatcher.stopped = true;
			activeWatcher = null;
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.notify("autofix: stopped", "info");
		},
	});
}
