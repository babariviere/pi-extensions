/**
 * PORTED from upstream `src/core/pi-bash-error.ts`.
 *
 * `pi.bash({ settle: true })` turns an ordinary nonzero exit into an
 * `{ ok: false, exitCode }` envelope. The exit status used to be recovered by
 * parsing the error text, which any `tool_result` middleware could rewrite.
 * Classify the exit once at the execute boundary instead and carry it as
 * structured metadata from there on.
 */

/** An ordinary bash exit, classified at the execute boundary before middleware. */
class PiBashExitError extends Error {
	constructor(
		message: string,
		readonly exitCode: number,
		readonly output: string,
	) {
		super(message);
	}
}

// Pi exposes process status in its native exception text. Parse that contract
// only at tool execution, never from a preflight/approval error or a decorated
// tool_result, so the guest stays independent of display formatting.
export const classifyPiBashError = (error: unknown): unknown => {
	if (!(error instanceof Error)) return error;
	const match = /(?:^|\n\n)Command exited with code (\d+)$/.exec(error.message);
	if (!match) return error;
	const exitCode = Number(match[1]);
	if (!Number.isSafeInteger(exitCode) || exitCode <= 0) return error;
	return new PiBashExitError(error.message, exitCode, error.message.slice(0, match.index));
};

// Display cleanup only: this never decides whether an error is a native exit.
// Work exclusively with the final text so redacted content stays gone.
const bashResultOutput = (original: PiBashExitError, text: string): string => {
	const index = text.indexOf(original.message);
	if (index >= 0) {
		// The unchanged native message locates its status suffix unambiguously, even
		// when stdout contains identical status-looking lines.
		return text.slice(0, index + original.output.length) + text.slice(index + original.message.length);
	}
	// Middleware may trim, redact, split content blocks, or normalize newlines.
	// Remove a remaining native status line only when there is one candidate.
	const marker = new RegExp(`(?:^|\\r?\\n\\r?\\n)Command exited with code ${original.exitCode}(?=\\r?\\n|$)`, "g");
	const match = marker.exec(text);
	if (!match || marker.exec(text)) return text;
	return text.slice(0, match.index) + text.slice(match.index + match[0].length);
};

/** Keep native exit status independent of middleware display transformations. */
export const piBashResultError = (original: unknown, text: string): Error =>
	original instanceof PiBashExitError
		? new PiBashExitError(text, original.exitCode, bashResultOutput(original, text))
		: new Error(text.trim() || "Pi bash failed");

/** Only provider-classified exits may cross the runtime bridge as settle metadata. */
export const piBashExitMetadata = (error: unknown): { exitCode: number; output: string } | undefined =>
	error instanceof PiBashExitError ? { exitCode: error.exitCode, output: error.output } : undefined;
