/**
 * herdr transport seam: how a `herdr` CLI command is actually run.
 *
 * One interface (`HerdrTransport`), one production adapter (`execFileTransport`,
 * which shells out to the `herdr` binary). `HerdrClient` (`herdr-client.ts`)
 * depends only on the interface, so tests inject an in-memory transport instead
 * of a fake `herdr` on `PATH`.
 */

import { execFile } from "node:child_process";
import { type HerdrCliResult, parseHerdrJson } from "./herdr-parse.ts";

export function isInHerdr(): boolean {
	return process.env.HERDR_ENV === "1" && !!process.env.HERDR_SOCKET_PATH;
}

export function currentWorkspaceId(): string | undefined {
	return process.env.HERDR_WORKSPACE_ID || undefined;
}

/** Runs one `herdr` CLI command and returns its parsed result. Never throws. */
export interface HerdrTransport {
	run(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<HerdrCliResult>;
}

/**
 * Production transport: shell out to `herdr` and parse its JSON stdout. Never
 * throws — a nonzero exit or unparseable output resolves to `{ ok: false }`.
 * A clean exit with no JSON payload (some commands succeed silently, e.g.
 * `pane run`) resolves to an empty-result success.
 */
export const execFileTransport: HerdrTransport = {
	run(args: string[], timeoutMs = 10000, signal?: AbortSignal): Promise<HerdrCliResult> {
		return new Promise((resolve) => {
			execFile("herdr", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal }, (err, stdout, stderr) => {
				const text = (stdout || "").trim();
				const parsed = parseHerdrJson(text);
				if (parsed) {
					resolve({ ...parsed, stdout: text });
					return;
				}
				if (err) {
					resolve({ ok: false, error: (stderr || err.message || "herdr command failed").trim(), stdout: text });
					return;
				}
				resolve({ ok: true, result: {}, stdout: text });
			});
		});
	},
};
