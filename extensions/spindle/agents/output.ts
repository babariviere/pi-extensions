/**
 * A run's output artifact, end to end: where it is written and what ends up in
 * it.
 *
 * Two concerns live here so they stop scattering across request.ts, paths.ts
 * and both adapters:
 *  - the `output` override lifecycle (normalize → index-suffix a batch →
 *    resolve to an absolute path), and
 *  - output *resolution* (read the child transcript's last assistant message,
 *    fall back to a backend source, persist, decide `ok`).
 *
 * `paths.ts` still owns the run-dir layout (it produces the default output
 * path); this module decides which destination a run actually uses and what it
 * contains.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

// --- output override lifecycle ----------------------------------------------

/**
 * Normalize a raw `output` override to a real path or `undefined`. Empty
 * strings and the boolean-ish literals `false`/`true` (case-insensitive) are
 * treated as "no override" so a quoted frontmatter value (`output: "false"`) or
 * a stray literal from a tool call falls back to the default per-run path
 * instead of writing bogus `false`/`false-1` files.
 */
export function normalizeOutputOverride(override: string | undefined): string | undefined {
	const trimmed = override?.trim();
	if (!trimmed) return undefined;
	const lower = trimmed.toLowerCase();
	if (lower === "false" || lower === "true") return undefined;
	return trimmed;
}

/**
 * Resolve a per-run `output` override to an absolute path. Absolute overrides
 * are used as-is; relative ones anchor to the parent's cwd so artifacts land
 * where the caller expects (e.g. `.pi/goal/plan.md` under the repo root).
 */
export function resolveOutputOverride(cwd: string, override: string): string {
	return isAbsolute(override) ? override : join(cwd, override);
}

/**
 * Insert a `-<index>` suffix before an output override's file extension so
 * parallel runs that share one override do not all write to the same file (and
 * clobber each other). Directory and absolute/relative shape are preserved:
 *   `plan.md` -> `plan-0.md`, `.pi/goal/plan.md` -> `.pi/goal/plan-0.md`,
 *   `/abs/out.md` -> `/abs/out-0.md`, `report` (no ext) -> `report-0`.
 */
export function indexOutputOverride(override: string, index: number): string {
	const dir = dirname(override);
	const base = basename(override);
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : "";
	const indexed = `${stem}-${index}${ext}`;
	return dir === "." ? indexed : join(dir, indexed);
}

/**
 * Resolve a whole batch's output overrides. Each raw override is normalized;
 * then, for a parallel batch (more than one run), every output-bearing run gets
 * a distinct `-<index>` suffix so they do not clobber each other. A single run
 * keeps its override verbatim, preserving stable destinations like
 * `.pi/goal/plan.md`. The returned array is aligned by index with the input.
 */
export function planBatchOutputs(rawOverrides: readonly (string | undefined)[]): (string | undefined)[] {
	const normalized = rawOverrides.map(normalizeOutputOverride);
	if (normalized.length <= 1) return normalized;
	return normalized.map((value, index) => (value ? indexOutputOverride(value, index) : value));
}

/**
 * The absolute file a run writes: the resolved per-run override when set, else
 * the run-dir default that `paths.ts` computed.
 */
export function outputPathFor(cwd: string, runDirDefault: string, override?: string): string {
	return override ? resolveOutputOverride(cwd, override) : runDirDefault;
}

// --- output resolution ------------------------------------------------------

/**
 * A run's result is its final assistant message, read from the child pi session
 * transcript. This is the primary (and only) result channel: agents reliably
 * end a turn with a final message, whereas a dedicated submit tool is easy to
 * forget and, in full code mode, is hidden behind the `extensions.*` namespace.
 * Returns the concatenated text of the last assistant message that had any text
 * (tool-only final turns fall back to the previous text turn), or undefined
 * when the transcript is unreadable or has no assistant text.
 */
export function readLastAssistantText(sessionPath: string): string | undefined {
	let raw: string;
	try {
		raw = readFileSync(sessionPath, "utf-8");
	} catch {
		return undefined;
	}
	let last: string | undefined;
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const msg = (obj as { message?: { role?: unknown; content?: unknown } }).message;
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const text = msg.content
			.filter(
				(c): c is { type: string; text: string } =>
					!!c &&
					typeof c === "object" &&
					(c as { type?: unknown }).type === "text" &&
					typeof (c as { text?: unknown }).text === "string",
			)
			.map((c) => c.text)
			.join("")
			.trim();
		if (text.length > 0) last = text;
	}
	return last;
}

/**
 * Persist the resolved result to disk; never throws. Parent directories are
 * created (`mkdir -p`) because a caller `output:` override routinely points at
 * a directory that does not exist yet (e.g. a per-night report dir), and a bare
 * `writeFileSync` would fail with ENOENT.
 *
 * Returns undefined on success, else a caller-facing reason. Failures are not
 * fatal (the caller already has the text in-band) but they must be reported:
 * silently swallowing them made the tool return an `outputPath` for a file that
 * was never written.
 */
function persistResult(path: string, text: string): string | undefined {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text, { mode: 0o600 });
		return undefined;
	} catch (err) {
		return `could not write the result to ${path}: ${err instanceof Error ? err.message : String(err)}`;
	}
}

/** The backend-specific inputs output resolution needs from an adapter. */
export interface RunOutputSource {
	/**
	 * Fallback text source, used only when the transcript yields nothing
	 * (headless: captured stdout; herdr: pane scrollback). Async so it runs only
	 * when needed.
	 */
	fallback: () => Promise<string | undefined> | string | undefined;
	/** Whether the run finished cleanly (headless exit 0; herdr stable/finished). */
	finishedCleanly: boolean;
	/** Placeholder text when no source yields output. */
	placeholder?: string;
}

export interface ResolvedOutput {
	output: string;
	ok: boolean;
	/**
	 * The file the result was actually written to. Undefined when nothing was
	 * persisted (no output, or the write failed), so a consumer never reports a
	 * path that does not exist.
	 */
	outputPath?: string;
	/** Why persistence failed, when it did. Surfaced to the caller as an error. */
	writeError?: string;
}

/**
 * Resolve a run's final output and success. The result is the child's last
 * assistant message (see `readLastAssistantText`), falling back to the
 * backend-specific `source.fallback` only when the transcript yields nothing.
 * Any resolved text is persisted to `outputPath` (the run-dir artifact, or a
 * caller `output:` override), creating its parent directories. The returned
 * `outputPath` is set only when that write actually landed; a failed write is
 * reported as `writeError` instead.
 *
 * A run is `ok` when it produced usable output AND finished cleanly. When no
 * source yields text, `output` is a placeholder and `ok` is false.
 */
export async function resolveRunOutput(
	outputPath: string,
	sessionPath: string,
	source: RunOutputSource,
): Promise<ResolvedOutput> {
	let output = readLastAssistantText(sessionPath);
	if (output === undefined) output = (await source.fallback()) || undefined;
	const writeError = output === undefined ? undefined : persistResult(outputPath, output);
	const ok = output !== undefined && source.finishedCleanly;
	return {
		output: output ?? source.placeholder ?? "(no output produced)",
		ok,
		...(output !== undefined && !writeError ? { outputPath } : {}),
		...(writeError ? { writeError } : {}),
	};
}
