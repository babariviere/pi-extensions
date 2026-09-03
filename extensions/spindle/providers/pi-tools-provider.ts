import {
	type BashOperations,
	type EditOperations,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	type AgentToolResult,
	type ExtensionRunner,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createSpindleBashToolDefinition } from "./spindle-bash-tool.ts";
import { runAbortable, throwIfAborted } from "../async-settlement.ts";
import { classifyPiBashError, piBashResultError } from "../core/pi-bash-error.ts";
import { CapturedToolCatalog } from "../capture/catalog.ts";
import { PI_CORE_TOOL_NAMES, type PiCoreToolName } from "../core/pi-tools.ts";
import { DEFAULT_SPINDLE_CONFIG } from "../config.ts";
import { expandSkillDirMarkersForRead } from "../core/skill-dir.ts";
import type {
	SpindleActionDescriptor,
	SpindleInvocationContext,
	SpindleMediaBlock,
	SpindleProvider,
	SpindleProviderListRequest,
} from "../protocol.ts";
import { countContentLines } from "../ui/preview-lines.ts";
import { CapturedToolsProvider } from "./captured-tools-provider.ts";
import { createPreviewWriteToolDefinition, writeContentForPreview } from "./write-preview.ts";

const MAX_RENDERER_ARGUMENT_CHARS = 200_000;

// The content array every pi core tool returns: text and/or image blocks.
type ToolContent = AgentToolResult<unknown>["content"];

const textContent = (content: ToolContent): string =>
	content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");

const imageBlocks = (content: unknown): SpindleMediaBlock[] => {
	if (!Array.isArray(content)) return [];
	const blocks: SpindleMediaBlock[] = [];
	for (const part of content) {
		if (
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown }).type === "image" &&
			typeof (part as { data?: unknown }).data === "string" &&
			typeof (part as { mimeType?: unknown }).mimeType === "string"
		) {
			blocks.push({
				type: "image",
				data: (part as { data: string }).data,
				mimeType: (part as { mimeType: string }).mimeType,
			});
		}
	}
	return blocks;
};

/**
 * What pi core's read tool reports on `details.truncation` when it cut the
 * content short. Only the fields this module reads are named.
 */
interface ReadTruncation {
	truncated?: boolean;
	truncatedBy?: "lines" | "bytes" | null;
	firstLineExceedsLimit?: boolean;
	totalLines?: number;
	totalBytes?: number;
	outputLines?: number;
	outputBytes?: number;
}

const readTruncation = (details: unknown): ReadTruncation | undefined => {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const truncation = (details as { truncation?: unknown }).truncation;
	if (!truncation || typeof truncation !== "object" || Array.isArray(truncation)) return undefined;
	return truncation as ReadTruncation;
};

const formatBytes = (bytes: number | undefined): string =>
	bytes === undefined ? "unknown size" : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

/**
 * A read that came back short must not look like a read that came back whole.
 *
 * pi's read tool caps its output at the model's context budget (2000 lines /
 * 50 KB) and reports the cut as a sentence appended to the text: fine for a
 * model that reads the sentence, silently lossy for a program that slices the
 * string. It cost this repository real data on 2026-09-03, when a restructure
 * of a 51 KB notes file was derived from a truncated read and dropped nine
 * lines, pasting the notice into the file as content.
 *
 * The machine-readable signal was there all along (`details.truncation`) and was
 * being discarded one function up. Now an involuntary cut throws, naming the
 * shortfall and the two ways forward. Paging with an explicit `limit` is not
 * affected: core reports that case without a `truncation` record.
 */
function assertReadNotTruncated(details: unknown, args: Record<string, unknown>): void {
	const truncation = readTruncation(details);
	if (!truncation) return;
	if (!truncation.truncated && !truncation.firstLineExceedsLimit) return;
	const path = typeof args.path === "string" ? args.path : "the file";
	const alternatives =
		"Filter it in pi.bash (rg/sed/jq) instead of pulling the whole file into the sandbox, or page it with offset.";
	if (truncation.firstLineExceedsLimit) {
		throw new Error(
			`pi.read(${path}) returned nothing: its first line alone is ${formatBytes(truncation.totalBytes)}, past pi's ` +
				`read limit. ${alternatives}`,
		);
	}
	const offset = typeof args.offset === "number" ? args.offset : 1;
	const next = offset + (truncation.outputLines ?? 0);
	throw new Error(
		`pi.read(${path}) was truncated by pi's read limit: ${truncation.outputLines ?? "?"} of ` +
			`${truncation.totalLines ?? "?"} lines, ${formatBytes(truncation.outputBytes)} of ` +
			`${formatBytes(truncation.totalBytes)}. The sandbox refuses to hand back a short read as if it were whole: ` +
			`continue from offset ${next}, or read it in one piece another way. ${alternatives}`,
	);
}
const normalizeResult = (
	name: PiCoreToolName,
	result: { content: ToolContent; details?: unknown; isError?: boolean },
): unknown => {
	const text = textContent(result.content);
	if (result.isError) throw new Error(text || `${name} failed`);
	if (name === "read" || name === "grep" || name === "find" || name === "ls") {
		return text;
	}
	let details = result.details;
	if (name === "bash" && details && typeof details === "object" && !Array.isArray(details)) {
		const detailRecord = details as Record<string, unknown>;
		const truncation = detailRecord.truncation;
		if (truncation && typeof truncation === "object" && !Array.isArray(truncation)) {
			const { content, ...truncationMetadata } = truncation as Record<string, unknown>;
			if (typeof content === "string" && text.includes(content)) {
				details = { ...detailRecord, truncation: truncationMetadata };
			}
		}
	}
	if (name === "write" && details && typeof details === "object" && !Array.isArray(details)) {
		const { codePreviewBeforeWrite: _before, ...publicDetails } = details as Record<string, unknown>;
		details = Object.keys(publicDetails).length > 0 ? publicDetails : undefined;
	}
	return {
		ok: true,
		output: text,
		details: details ?? null,
	};
};

// Shape of a pi core tool's execute() result. AgentToolResult<unknown> is
// { content, details, terminate? }; pi core tools throw on error rather than
// returning isError, so isError is tracked separately in #invokeWithEvents.
interface PiToolResult {
	content: ToolContent;
	details: unknown;
	terminate?: boolean;
}

/**
 * Sandbox hooks for the mutating core tools. Built by `SpindleSandbox`; absent
 * when the policy enforces nothing, in which case pi's defaults are used
 * unchanged.
 */
export interface PiToolsSandbox {
	bash?: BashOperations;
	/** Wrap a command for the OS sandbox when one is active (pi.bash stdin path). */
	wrapCommand?: (command: string) => Promise<string>;
	edit?: EditOperations;
	writeGuard?: (absolutePath: string) => void;
	/**
	 * Path check enforcing the sandbox policy's denyRead roots on the read
	 * tools (`read` / `grep` / `find` / `ls`). Denied reads throw before the
	 * tool runs; everything else keeps pi's behavior unchanged.
	 */
	readGuard?: (absolutePath: string) => void;
}

export class PiToolsProvider implements SpindleProvider {
	readonly name = "pi";
	readonly description = "Pi's built-in coding tools";
	readonly #tools: Record<PiCoreToolName, ToolDefinition<any, any, any>>;
	readonly #catalog: CapturedToolCatalog | undefined;
	readonly #capturedTools: CapturedToolsProvider | undefined;
	readonly #cwd: string;
	readonly #readGuard: ((absolutePath: string) => void) | undefined;
	/** Ceiling on a single `pi.read`; see `executor.readMaxBytes`. */
	readonly #readMaxBytes: number;

	constructor(
		cwd: string,
		catalog?: CapturedToolCatalog,
		capturedTools?: CapturedToolsProvider,
		sandbox?: PiToolsSandbox,
		limits?: { readMaxBytes?: number },
	) {
		this.#cwd = cwd;
		this.#readGuard = sandbox?.readGuard;
		this.#readMaxBytes = limits?.readMaxBytes ?? DEFAULT_SPINDLE_CONFIG.executor.readMaxBytes;
		// The mutating tools are gated: `bash` by the OS sandbox, `write` and
		// `edit` by a path check. The read tools keep pi's definitions (image
		// handling, truncation and offsets stay identical) but the sandbox's
		// denyRead roots are checked first, so a sandboxed program cannot read a
		// credential the OS sandbox would already hide from `bash`.
		this.#tools = {
			read: createReadToolDefinition(cwd),
			bash: createSpindleBashToolDefinition(cwd, {
				operations: sandbox?.bash,
				wrapCommand: sandbox?.wrapCommand,
			}),
			edit: createEditToolDefinition(cwd, sandbox?.edit ? { operations: sandbox.edit } : undefined),
			write: createPreviewWriteToolDefinition(cwd, sandbox?.writeGuard),
			grep: createGrepToolDefinition(cwd),
			find: createFindToolDefinition(cwd),
			ls: createLsToolDefinition(cwd),
		};
		this.#catalog = catalog;
		this.#capturedTools = capturedTools;
	}

	async list(
		request: SpindleProviderListRequest,
		_context: SpindleInvocationContext,
	): Promise<SpindleActionDescriptor[]> {
		const query = request.query?.toLowerCase();
		const descriptors = await Promise.all(PI_CORE_TOOL_NAMES.map((name) => this.describe(name, _context)));
		return descriptors
			.filter((descriptor): descriptor is SpindleActionDescriptor => descriptor !== undefined)
			.filter((descriptor) =>
				query ? `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query) : true,
			);
	}

	async describe(
		actionName: string,
		_context: SpindleInvocationContext,
	): Promise<SpindleActionDescriptor | undefined> {
		if (!(actionName in this.#tools)) return undefined;
		const name = actionName as PiCoreToolName;
		const override = await this.#capturedTools?.describe(name, _context);
		if (override) return { ...override, namespace: "extension-override" };
		const tool = this.#tools[name];
		return this.#descriptor(name, tool);
	}

	prepareArguments(actionName: string, args: Record<string, unknown>): Record<string, unknown> {
		if (this.#catalog?.get(actionName)) {
			return this.#capturedTools!.prepareArguments(actionName, args);
		}
		if (!(actionName in this.#tools)) return args;
		const prepare = this.#tools[actionName as PiCoreToolName].prepareArguments;
		if (!prepare) return args;
		const prepared = prepare(args);
		if (typeof prepared !== "object" || prepared === null || Array.isArray(prepared)) {
			throw new Error(`Pi tool ${actionName} prepared non-object arguments`);
		}
		return prepared as Record<string, unknown>;
	}

	async invoke(
		actionName: string,
		args: Record<string, unknown>,
		context: SpindleInvocationContext,
	): Promise<unknown> {
		if (!(actionName in this.#tools)) throw new Error(`Unknown Pi tool: ${actionName}`);
		const name = actionName as PiCoreToolName;
		// Runs for captured overrides too: the denyRead roots must bind every
		// path a read-shaped tool can open.
		if (name === "read" || name === "grep" || name === "find" || name === "ls") {
			this.#guardReadPath(args);
		}
		// A captured extension override (e.g. an extension that registered a "read"
		// tool) already replays the full event lifecycle itself via
		// CapturedToolsProvider, so delegate to it unchanged.
		if (this.#catalog?.get(name)) {
			const result = await this.#capturedTools!.invoke(name, args, context);
			this.#attachReadMedia(name, result, context);
			this.#attachReadNote(name, result, context);
			this.#attachPreview(name, result, args, context);
			return this.#normalizeResult(name, result, args);
		}
		const tool = this.#tools[name];
		const runner = this.#catalog?.runner;
		// Without a runner (e.g. before the first tool refresh populated the
		// catalog) fall back to a direct execute — no extension hooks fire, but
		// the call still works. Once tools are refreshed the runner is available.
		if (!runner) {
			const result = await runAbortable(context.signal, () =>
				tool.execute(
					context.nestedToolCallId,
					args,
					context.signal,
					(partialResult) => this.#attachPartialPreview(name, partialResult, args, context),
					context.extensionContext,
				),
			);
			this.#attachReadMedia(name, result, context);
			this.#attachReadNote(name, result, context);
			this.#attachPreview(name, result, args, context);
			return this.#normalizeResult(name, result, args);
		}
		return this.#invokeWithEvents(name, tool, args, context, runner);
	}

	// Apply the sandbox read guard to a read-shaped call. `path` is canonical
	// post-alias-normalization, but the sibling spellings are checked too so a
	// generic `tools.call` with raw args cannot slip past the guard.
	#guardReadPath(args: Record<string, unknown>): void {
		if (this.#readGuard === undefined) return;
		const candidate = args.path ?? args.file ?? args.dir;
		if (typeof candidate !== "string" || candidate === "") return;
		this.#readGuard(isAbsolute(candidate) ? candidate : resolve(this.#cwd, candidate));
	}

	// Replay the agent-core tool-execution lifecycle for a nested pi.* call, so
	// extensions that hook tool_call / tool_result / tool_execution_* see pi
	// core tools invoked through spindle_exec in full-code mode — exactly as
	// they would for a top-level call in the normal (non-codemode) flow, and
	// exactly as CapturedToolsProvider already does for captured extension
	// tools. tool_result patches (content/details/isError) are applied, so
	// extensions like pi-vision-handoff can replace image blocks with text
	// descriptions before the result returns to the sandbox.
	async #invokeWithEvents(
		name: PiCoreToolName,
		tool: ToolDefinition<any, any, any>,
		args: Record<string, unknown>,
		context: SpindleInvocationContext,
		runner: ExtensionRunner,
	): Promise<unknown> {
		const toolCallId = context.nestedToolCallId;
		await runAbortable(context.signal, () =>
			runner.emit({
				type: "tool_execution_start",
				toolCallId,
				toolName: name,
				args,
			}),
		);
		let result: PiToolResult;
		let isError = false;
		let thrown: unknown;
		let updateTail: Promise<void> = Promise.resolve();
		try {
			const preflight = await runAbortable(context.signal, () =>
				runner.emitToolCall({
					type: "tool_call",
					toolName: name,
					toolCallId,
					input: args,
				}),
			);
			context.updateArguments?.(args);
			if (preflight?.block) {
				throw new Error(preflight.reason || `Pi tool ${name} was blocked`);
			}
			result = (await runAbortable(context.signal, () =>
				tool.execute(
					toolCallId,
					args,
					context.signal,
					(partialResult) => {
						this.#attachPartialPreview(name, partialResult, args, context);
						updateTail = updateTail
							.then(() =>
								runAbortable(context.signal, () =>
									runner.emit({
										type: "tool_execution_update",
										toolCallId,
										toolName: name,
										args,
										partialResult,
									}),
								),
							)
							.catch(() => undefined);
					},
					context.extensionContext,
				),
			)) as PiToolResult;
		} catch (error) {
			// Classify an ordinary bash exit here, before any tool_result middleware
			// can rewrite the message the settle envelope is derived from.
			thrown = name === "bash" ? classifyPiBashError(error) : error;
			isError = true;
			result = {
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				details: undefined,
			};
		}

		await updateTail;
		throwIfAborted(context.signal);

		// Capture the read's image blocks BEFORE any tool_result patch —
		// pi-vision-handoff swaps image→description here, which would leave
		// nothing to re-attach for the kitty preview.
		this.#attachReadMedia(name, result, context);

		const patch = await runAbortable(context.signal, () =>
			runner.emitToolResult({
				type: "tool_result",
				toolName: name,
				toolCallId,
				input: args,
				content: result.content,
				details: result.details,
				isError,
			}),
		);
		if (patch) {
			result = {
				...result,
				content: patch.content ?? result.content,
				...(patch.details !== undefined ? { details: patch.details } : {}),
			};
			isError = patch.isError ?? isError;
		}

		// Capture the read's clean text note AFTER the patch — the handoff strips
		// pi's non-vision note and swaps the image for a description, so the first
		// surviving text block is the short read note (not the verbose description).
		this.#attachReadNote(name, result, context);

		await runAbortable(context.signal, () =>
			runner.emit({
				type: "tool_execution_end",
				toolCallId,
				toolName: name,
				result,
				isError,
			}),
		);

		if (isError) {
			const text = textContent(result.content).trim();
			// bash keeps its classified exit status across middleware so settle:true
			// still yields an { ok: false, exitCode } envelope in the sandbox.
			if (name === "bash") throw piBashResultError(thrown, text);
			throw new Error(text || (thrown instanceof Error ? thrown.message : `Pi tool ${name} failed`));
		}
		this.#attachPreview(name, result, args, context);
		return this.#normalizeResult(name, result, args);
	}

	// Schema-enforce and early-startup calls may have no ExtensionRunner, so the
	// top-level tool_result marker middleware cannot run. Expand again at the
	// provider boundary; replacement is idempotent when middleware already ran.
	#normalizeResult(
		name: PiCoreToolName,
		result: { content: ToolContent; details?: unknown; isError?: boolean },
		args: Record<string, unknown>,
	): unknown {
		const normalized = normalizeResult(name, result);
		if (name !== "read" || typeof normalized !== "string") return normalized;
		// pi cut the file at its context budget. The sandbox is not context, so read
		// the rest here rather than hand back a head (`#readWholeFile`), and only
		// refuse when the file is past the guest's own ceiling.
		const whole = this.#readWholeFile(result.details, args);
		// Belt and braces: if the file could not be widened (no path to re-read),
		// the cut still has to be loud rather than silently short.
		if (whole === undefined) assertReadNotTruncated(result.details, args);
		return expandSkillDirMarkersForRead(whole ?? normalized, args, this.#cwd);
	}

	/**
	 * Re-read a file pi truncated, whole, up to `readMaxBytes`.
	 *
	 * Only reached when pi reported an involuntary cut, so an untruncated read
	 * keeps pi's own code path (and its media handling) untouched. The read guard
	 * already ran on this path in `invoke`, on the same resolved path.
	 *
	 * Returns undefined when there was nothing to widen. Throws when the file is
	 * larger than the ceiling: a program that asked for 200 MB of log gets an
	 * error naming the size, not a silent head and not an out-of-memory an hour
	 * later.
	 */
	#readWholeFile(details: unknown, args: Record<string, unknown>): string | undefined {
		const truncation = readTruncation(details);
		if (!truncation || (!truncation.truncated && !truncation.firstLineExceedsLimit)) return undefined;
		if (typeof args.path !== "string" || args.path === "") return undefined;
		const absolute = isAbsolute(args.path) ? args.path : resolve(this.#cwd, args.path);

		const size = truncation.totalBytes ?? statSync(absolute).size;
		if (size > this.#readMaxBytes) {
			throw new Error(
				`pi.read(${args.path}) is ${formatBytes(size)}, past the sandbox's ${formatBytes(this.#readMaxBytes)} read ` +
					"ceiling (executor.readMaxBytes). Filter it in pi.bash (rg/sed/jq) instead of pulling the whole file " +
					"into the sandbox, or page it with offset and limit.",
			);
		}

		const content = readFileSync(absolute, "utf-8");
		// `offset` is 1-indexed and `limit` counts lines, as in pi's read tool.
		const offset = typeof args.offset === "number" ? Math.max(1, Math.floor(args.offset)) : 1;
		const limit = typeof args.limit === "number" ? Math.max(0, Math.floor(args.limit)) : undefined;
		if (offset === 1 && limit === undefined) return content;
		const lines = content.split("\n");
		const start = offset - 1;
		return lines.slice(start, limit === undefined ? undefined : start + limit).join("\n");
	}

	#attachPartialPreview(
		name: PiCoreToolName,
		partialResult: { content: ToolContent; details?: unknown; isError?: boolean },
		args: Record<string, unknown>,
		context: SpindleInvocationContext,
	): void {
		const progress = textContent(partialResult.content).trim();
		const boundedProgress = Array.from(progress).slice(-4_000).join("");
		const bashCommand =
			name === "bash" && typeof args.command === "string" && args.command.length <= MAX_RENDERER_ARGUMENT_CHARS
				? args.command
				: undefined;
		context.attachPreview?.({
			result: boundedProgress,
			...(bashCommand !== undefined ? { bashCommand } : {}),
		});
		context.update(`${name}: ${boundedProgress.slice(-500) || "running"}`);
	}

	#attachPreview(
		name: PiCoreToolName,
		result: { content: ToolContent; details?: unknown; isError?: boolean },
		args: Record<string, unknown>,
		context: SpindleInvocationContext,
	): void {
		if (result.isError) return;
		const details = result.details;
		const detailRecord =
			typeof details === "object" && details !== null && !Array.isArray(details)
				? (details as Record<string, unknown>)
				: undefined;
		const bashCommand =
			name === "bash" && typeof args.command === "string" && args.command.length <= MAX_RENDERER_ARGUMENT_CHARS
				? args.command
				: undefined;
		const writeInput = name === "write" && typeof args.content === "string" ? args.content : undefined;
		const writeContent = writeInput !== undefined ? writeContentForPreview(writeInput) : undefined;
		const writeByteLength = writeInput !== undefined ? Buffer.byteLength(writeInput, "utf8") : undefined;
		const writeLineCount = writeInput !== undefined ? countContentLines(writeInput) : undefined;
		const hasWriteBefore =
			name === "write" &&
			detailRecord !== undefined &&
			Object.prototype.hasOwnProperty.call(detailRecord, "codePreviewBeforeWrite");
		context.attachPreview?.({
			result: normalizeResult(name, result),
			...(bashCommand !== undefined ? { bashCommand } : {}),
			...(writeContent !== undefined ? { writeContent } : {}),
			...(writeByteLength !== undefined ? { writeByteLength } : {}),
			...(writeLineCount !== undefined ? { writeLineCount } : {}),
			...(details !== undefined ? { details } : {}),
			...(hasWriteBefore
				? {
						codePreviewBeforeWrite: detailRecord?.codePreviewBeforeWrite,
						writeBeforeCaptured: true,
					}
				: {}),
		});
	}

	// `pi.read` of an image file returns `{ type: "image" }` content blocks.
	// normalizeResult strips them — the sandbox holds text only and the model
	// return is a string — but the single-call render wants them re-attached so
	// pi core's ToolExecutionComponent renders the kitty image preview, the same
	// path a native `read` takes. Hand them out-of-band via context.attachMedia,
	// which the ActionRegistry stashes on the call audit; this bypasses the
	// result char bound that would otherwise truncate the base64 payload.
	//
	// Must run BEFORE any tool_result patch: pi-vision-handoff SWAPS image blocks
	// for text descriptions here (so the description becomes the sandbox value),
	// which would leave no image to capture. Capturing the original blocks lets
	// the single-call render show the kitty image, and the handoff's `context`
	// hook supplies the description to the model — exactly how a native `read`
	// keeps its image for kitty and swaps it only on the LLM-bound clone.
	#attachReadMedia(name: PiCoreToolName, result: { content?: unknown }, context: SpindleInvocationContext): void {
		if (name !== "read") return;
		const blocks = imageBlocks(result?.content);
		if (blocks.length > 0) context.attachMedia?.(blocks);
	}

	// The read tool's own text note (e.g. "Read image file [image/png]"), captured
	// AFTER any tool_result patch — pi-vision-handoff swaps image→description and
	// strips pi's "[Current model does not support images…]" note there, so the
	// first surviving text block is the clean note. Used as the single-call body
	// and content text so the preview shows the kitty image + the clean note
	// instead of the handoff's verbose description; the model still receives the
	// description via the handoff's `context` hook swapping the image block.
	#attachReadNote(name: PiCoreToolName, result: { content?: unknown }, context: SpindleInvocationContext): void {
		if (name !== "read") return;
		const content = result?.content;
		if (!Array.isArray(content)) return;
		for (const block of content) {
			if (
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
			) {
				context.attachMedia?.([], (block as { text: string }).text);
				return;
			}
		}
	}

	#descriptor(name: PiCoreToolName, tool: ToolDefinition<any, any, any>): SpindleActionDescriptor {
		return {
			name,
			description: tool.description,
			inputSchema: tool.parameters as unknown as Record<string, unknown>,
			namespace: "builtin",
		};
	}
}
