import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import type { CodePreviewSettings } from "./ui/code-preview.ts";
import { type SpindleToolShellDecorator, withCodePreviewShell } from "./ui/code-preview-shell.ts";
import { Type } from "typebox";
import { createSpindlePersistedExecutionDetails, readSpindleExecutionRenderDetails } from "./audit/index.ts";
import { DEFAULT_SPINDLE_CONFIG } from "./config.ts";
import type { SpindleState } from "./spindle-state.ts";
import type { SpindleMediaBlock } from "./protocol.ts";
import {
	captureSpindleAgentPreviews,
	captureSpindleCallHeadlinePreviews,
	captureSpindleCoreToolPreviews,
	captureSpindleWritePreviews,
	expandHint,
	spindleMulticallCallLimit,
	spindleWriteBindings,
	inheritComponentBackground,
	modelReadHint,
	nestedCallBody,
	nestedCallTitle,
	renderBoundedLines,
	renderSpindleMulticallPartial,
	renderSpindleWriteArgumentPreview,
	renderNestedAgentToolLines,
	restoreSpindleAgentPreviews,
	restoreSpindleCallHeadlinePreviews,
	restoreSpindleCoreToolPreviews,
	restoreSpindleWritePreviews,
	restoreLegacyBashCommands,
	safeTerminalText,
	singleCallProgressLine,
	type SpindleAgentPreview,
	type SpindleCallHeadlinePreview,
	type SpindleCoreToolPreview,
	type SpindleRenderAudit,
	type SpindleWriteBinding,
	type SpindleWritePreview,
} from "./ui/spindle-render.ts";
import {
	coreToolPreviewEnabled,
	coreToolRendererEnabled,
	isCoreToolAudit,
	renderCoreToolBody,
} from "./ui/core-tool-render.ts";
import { highlightCode } from "./ui/highlight.ts";
import { HiddenRowBorrowingComponent, observeResultRows, type ResultRowBalance } from "./ui/row-balance.ts";
import { type SpinnerTimerState, updateSpinner } from "./ui/spinner.ts";
import { formatSpindleValue } from "./ui/structured.ts";
import { countNewlines, truncateMiddle } from "./util.ts";
import { prepareSpindleExecArguments, resolveSpindleExecPayloads } from "./spindle-exec-arguments.ts";
import { normalizeRunDisplay } from "./run-display.ts";
import { typeErrorRecoveryHint } from "./type-error-guidance.ts";
import { formatFailureProgress } from "./failure-progress.ts";
import { boundModelOutput, modelOutputBudget } from "./output-budget.ts";
import { formatSessionStoreBytes } from "./session-store.ts";
import {
	applySpindleStateNotes,
	readSpindleStateNotes,
	renderPayloadInspector,
	type SpindleStateNoteView,
} from "./ui/inspect-preview.ts";
import { repairSpindleGuestCode } from "./runtime/guest-code-repair.ts";

const RESULT_FORMATS = ["auto", "yaml", "json", "text"] as const;
const MAX_SPINDLE_CODE_TRANSFER_LINES = 12;

type SpindleRendererState = {
	spindleWriteBindingsCode?: string;
	spindleWriteBindings?: SpindleWriteBinding[];
	spindleWritePreviews?: SpindleWritePreview[];
	spindleCoreToolPreviews?: SpindleCoreToolPreview[];
	spindleCallHeadlinePreviews?: SpindleCallHeadlinePreview[];
	spindleAgentPreviews?: SpindleAgentPreview[];
	spindleStateNotes?: SpindleStateNoteView[];
	spindleResultRowBalance?: ResultRowBalance;
	spindleSpinner?: SpinnerTimerState;
};

const countLabel = (count: number, singular: string): string => `${count} ${count === 1 ? singular : `${singular}s`}`;

export const createSpindleExecTool = (
	state: SpindleState,
	codePreviewSettings: CodePreviewSettings,
	decorateShell: SpindleToolShellDecorator = withCodePreviewShell,
): ToolDefinition<any, any, any> =>
	decorateShell(
		defineTool({
			name: "spindle_exec",
			label: "Spindle",
			description:
				"Execute type-checked TypeScript in an isolated QuickJS sandbox to drive Pi core tools (`pi.*`), tools registered by sibling extensions (`extensions.*`), MCP tools from `mcp.json` (`mcp.*`), and custom markdown subagents (`agents.*`). In full code mode this is the exclusive model tool path.",
			promptSnippet: "Pi core tools, extension tools, MCP, and custom subagents",
			promptGuidelines: [
				"Batch independent operations in one `spindle_exec` program, not one call per tool; keep dependent/conditional steps sequential. Use `Promise.all` for a few independent calls; use `mapLimit(items, fn, N)` when fanning out over a wide list, because `Promise.all` receives promises that have already started and so cannot bound how many run at once. Return only the compact final value; intermediate results stay in the sandbox.",
				"Awkward payloads MUST go through `payloads` and be read as `π.key`, never inlined in `code`: multi-line file content, JSON blobs, long prose, and strings with literal `${...}`. Inlining multi-line content nests it through three escape layers and the model emits literal `\\n`, corrupting the file; template literals also interpolate `${...}`. E.g. `payloads: { body }` then `pi.write({ path, content: π.body })`; JSON-encode data and `JSON.parse(π.key)`.",
				"`process.env` exposes an allowlisted host environment (HOME, USER, SHELL, PWD, PATH, LANG, LC_*, TERM, TMPDIR, XDG_*); sensitive variables are never exposed. `pi.bash` accepts per-call `cwd` (absolute working directory), `env` (merged over the shell environment), and `stdin` (text piped to the command) — e.g. `pi.bash({ command: 'ssh host bash -s', stdin: π.script })` runs a multiline remote script without quoting tricks.",
			],
			// The model-facing schema is intentionally flat: one large `code` string
			// plus scalar/optional params. Do not add nested arrays-of-objects with
			// escaped content here. SOTA models are post-trained on one dominant
			// harness's flat tool shapes and can invent trailing keys at the
			// highest-entropy point of a nested escaped-JSON field, which a strict
			// schema hard-rejects. Keep this surface string/scalar-heavy; the only
			// nested field (display) ignores unknown keys. See
			// lucumr.pocoo.org/2026/7/4/better-models-worse-tools/ and pi-tool-repair.
			parameters: Type.Object({
				code: Type.String({
					description:
						"TypeScript function body. Top-level await and return are supported. Globals include `mcp`, `agents`, `mapLimit`, `print`, `π` (payloads), `τ` (session state), and `process` (allowlisted `process.env`, `process.cwd()`); full-code mode adds `pi` and `extensions`. `pi.bash` also takes `cwd`, `env`, and `stdin`. See session guidance / `spindle-exec` skill for exact signatures.",
				}),
				payloads: Type.Optional(
					Type.Record(Type.String(), Type.String(), {
						description:
							"Named payloads exposed as π.key. Use for any awkward payload: multi-line file content, JSON blobs, long prose, and strings with literal ${...}. JSON-encode structured data and JSON.parse(π.key) in the sandbox.",
					}),
				),

				resultFormat: Type.Optional(Type.Union(RESULT_FORMATS.map((value) => Type.Literal(value)))),
				agentBudget: Type.Optional(
					Type.Number({
						minimum: 1,
						description: "Optional agent-call cap, bounded by Spindle configuration",
					}),
				),
				timeoutMs: Type.Optional(
					Type.Number({
						minimum: 1,
						description:
							"Optional whole-program deadline in ms for this invocation; raises (never lowers) the configured executor.timeoutMs, capped by executor.maxTimeoutMs",
					}),
				),
				display: Type.Optional(
					Type.Union([
						Type.Object({
							name: Type.Optional(
								Type.String({ description: "Human-readable name for the Spindle activity widget" }),
							),
							description: Type.Optional(
								Type.String({ description: "Compact objective shown in the Spindle widget" }),
							),
						}),
						Type.String({
							description:
								"Objective shorthand normalized to { name } (a JSON-object string is parsed). Prefer the object form.",
						}),
					]),
				),
			}),
			// Pi validates custom-tool arguments before `tool_call` and `execute`, so
			// compatibility coercions for the model-facing boundary must live in the
			// official prepareArguments hook rather than execute-time fallbacks.
			prepareArguments(args) {
				return prepareSpindleExecArguments(args) as any;
			},
			renderCall(params, theme, context) {
				const code = Array.isArray(params.code) ? params.code.join("\n") : params.code;
				const rendererState = context.state as SpindleRendererState;
				const spinner = updateSpinner((rendererState.spindleSpinner ??= {}), context.isPartial, context.invalidate);
				const rowBalance = (rendererState.spindleResultRowBalance ??= {});
				if (rendererState.spindleWriteBindingsCode !== code) {
					rendererState.spindleWriteBindingsCode = code;
					rendererState.spindleWriteBindings = spindleWriteBindings(code);
				}
				const writePreview = context.executionStarted
					? null
					: renderSpindleWriteArgumentPreview(
							{
								bindings: rendererState.spindleWriteBindings ?? [],
								strings: resolveSpindleExecPayloads(params),
								expanded: context.expanded,
								cwd: context.cwd,
								settings: codePreviewSettings,
								spinner,
							},
							theme,
							context.invalidate,
						);

				const lines = safeTerminalText(code).split("\n");
				const runDisplayName = normalizeRunDisplay(params.display)?.name;
				const displayName = runDisplayName ? safeTerminalText(runDisplayName) : "";
				const title = `${theme.fg("toolTitle", theme.bold("spindle"))}${
					displayName ? ` ${theme.fg("accent", displayName)}` : ""
				} ${theme.fg("dim", `TypeScript · ${countLabel(lines.length, "line")}`)}`;
				const baseLimit = context.expanded ? lines.length : Math.min(lines.length, 8);
				const maxLimit = context.expanded
					? lines.length
					: Math.min(lines.length, baseLimit + MAX_SPINDLE_CODE_TRANSFER_LINES);
				const renderCodePreview = (limit: number, width: number): string[] => {
					const shown = lines.slice(0, limit);
					const lineNumberWidth = String(Math.max(1, shown.length)).length;
					const preview = shown
						.map(
							(line, index) =>
								`${theme.fg("dim", String(index + 1).padStart(lineNumberWidth, " "))} ${theme.fg("muted", line || " ")}`,
						)
						.join("\n");
					const hidden = lines.length - shown.length;
					const hiddenHint =
						hidden > 0
							? `\n${theme.fg("dim", `… ${countLabel(hidden, "line")} hidden · `)}${expandHint(theme)}`
							: "";
					return new Text(`${title}${preview ? `\n${preview}` : ""}${hiddenHint}`, 0, 0).render(width);
				};
				const codePreview = new HiddenRowBorrowingComponent(baseLimit, maxLimit, renderCodePreview, rowBalance);
				// `payloads` is where a program is told to put every awkward value, so
				// the code preview alone shows `π.body` and never what `body` is. The
				// write preview already renders payloads bound to a `pi.write` while the
				// call composes; skip those so nothing is shown twice.
				const payloadPreview = renderPayloadInspector({
					payloads: resolveSpindleExecPayloads(params),
					...(writePreview
						? {
								skipKeys: new Set(
									(rendererState.spindleWriteBindings ?? []).map((binding) => binding.stringKey),
								),
							}
						: {}),
					expanded: context.expanded,
					theme,
				});
				if (!writePreview && !payloadPreview) return codePreview;
				const composite = new Container();
				composite.addChild(codePreview);
				if (payloadPreview) composite.addChild(payloadPreview);
				if (writePreview) {
					composite.addChild(new Text("\n", 0, 0));
					composite.addChild(writePreview);
				}
				return composite;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				const details = readSpindleExecutionRenderDetails(result.details);
				let audits = restoreLegacyBashCommands(details.audits as SpindleRenderAudit[], context.args);
				const rendererState = context.state as SpindleRendererState;
				const spinner = updateSpinner((rendererState.spindleSpinner ??= {}), isPartial, context.invalidate);
				const rowBalance = (rendererState.spindleResultRowBalance ??= {});
				const trackRows = (component: Component): Component =>
					observeResultRows(inheritComponentBackground(component), rowBalance, { expanded, isPartial });
				if (isPartial) {
					rendererState.spindleCoreToolPreviews = captureSpindleCoreToolPreviews(
						audits,
						rendererState.spindleCoreToolPreviews,
					);
					rendererState.spindleAgentPreviews = captureSpindleAgentPreviews(
						audits,
						rendererState.spindleAgentPreviews,
					);
					const headlinePreviews = captureSpindleCallHeadlinePreviews(audits);
					if (headlinePreviews.length > 0) {
						rendererState.spindleCallHeadlinePreviews = headlinePreviews;
					}
					const writePreviews = captureSpindleWritePreviews(audits);
					if (writePreviews.length > 0) rendererState.spindleWritePreviews = writePreviews;
					// τ values ride the live update channel, never the durable trace, so
					// they have to be captured here to survive into the final render.
					const stateNotes = readSpindleStateNotes(result.details);
					if (stateNotes.length > 0) rendererState.spindleStateNotes = stateNotes;
				} else {
					if (rendererState.spindleCoreToolPreviews) {
						audits = restoreSpindleCoreToolPreviews(audits, rendererState.spindleCoreToolPreviews);
					}
					if (rendererState.spindleAgentPreviews) {
						audits = restoreSpindleAgentPreviews(audits, rendererState.spindleAgentPreviews);
					}
					if (rendererState.spindleCallHeadlinePreviews) {
						audits = restoreSpindleCallHeadlinePreviews(audits, rendererState.spindleCallHeadlinePreviews);
					}
					if (rendererState.spindleWritePreviews) {
						audits = restoreSpindleWritePreviews(audits, rendererState.spindleWritePreviews);
					}
					// The trace gives each τ operation a row and its key; this puts the
					// value back in the body.
					audits = applySpindleStateNotes(audits, rendererState.spindleStateNotes);
				}
				const phases = details.phases;
				const nl = "\n";
				const allRowIndexes = (lines: string[], enabled: boolean): ReadonlySet<number> | undefined =>
					enabled ? new Set(lines.map((_line, index) => index)) : undefined;
				const corePreviewContext = { cwd: context.cwd, settings: codePreviewSettings };
				const showNestedToolCalls = state.initialized
					? state.config.ui.showNestedToolCalls
					: DEFAULT_SPINDLE_CONFIG.ui.showNestedToolCalls;

				const renderBody = (audit: SpindleRenderAudit, limit: number): { body: string; hidden: number } | null => {
					const core = renderCoreToolBody(audit, theme, {
						cwd: context.cwd,
						settings: codePreviewSettings,
						expanded,
						maxLines: limit,
						...(context?.invalidate ? { invalidate: context.invalidate } : {}),
					});
					if (core) return { body: core.lines.join(nl), hidden: core.hidden };
					if (coreToolRendererEnabled(audit, codePreviewSettings)) return null;

					const body = nestedCallBody(audit);
					if (!body) return null;
					const bodyLines = safeTerminalText(body).split(nl);
					while (bodyLines.length > 0) {
						const last = bodyLines[bodyLines.length - 1];
						if (last === undefined || last.trim() === "") bodyLines.pop();
						else break;
					}
					if (bodyLines.length === 0) return null;
					const shown = bodyLines.slice(0, limit);
					return {
						body: shown.map((line) => theme.fg("toolOutput", line || " ")).join(nl),
						hidden: bodyLines.length - shown.length,
					};
				};

				if (isPartial) {
					const progress = details.progress;
					if (audits.length === 0) {
						return trackRows(
							new Text(
								theme.fg("warning", `◆ ${safeTerminalText(progress ?? "Running Spindle program…")}`),
								0,
								0,
							),
						);
					}
					if (audits.length === 1) {
						const audit = audits[0]!;
						const glyph =
							audit.success === undefined
								? theme.fg("warning", spinner)
								: audit.success === false
									? theme.fg("error", "✗")
									: theme.fg("dim", "›");
						let text = `${glyph} ${nestedCallTitle(audit, theme, context?.invalidate, corePreviewContext)}`;
						const nested = renderNestedAgentToolLines(audit, theme, {
							expanded,
							showTools: showNestedToolCalls,
							core: corePreviewContext,
							...(context?.invalidate ? { invalidate: context.invalidate } : {}),
						});
						const progressLine = singleCallProgressLine(progress, nested);
						if (audit.success === false && audit.error) {
							text += nl + `  ${theme.fg("error", safeTerminalText(audit.error))}`;
						} else {
							const rendered = renderBody(
								audit,
								expanded || coreToolRendererEnabled(audit, codePreviewSettings) ? 200 : 10,
							);
							if (rendered) {
								text += nl + rendered.body;
								if (rendered.hidden > 0) {
									text += nl + theme.fg("dim", `… ${countLabel(rendered.hidden, "line")}`);
									if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
								}
							} else if (
								isCoreToolAudit(audit) &&
								!expanded &&
								!coreToolPreviewEnabled(audit, codePreviewSettings)
							) {
								text += nl + theme.fg("muted", "╰─ ") + expandHint(theme);
							} else if (progressLine) {
								text += nl + theme.fg("dim", progressLine);
							}
						}
						if (audit.success !== false && nested[0]) {
							const firstBreak = text.indexOf(nl);
							if (firstBreak < 0) text += ` ${nested[0]}`;
							else text = `${text.slice(0, firstBreak)} ${nested[0]}${text.slice(firstBreak)}`;
							if (nested.length > 1) text += nl + nested.slice(1).join(nl);
						}
						const textLines = text.split(nl);
						return trackRows(
							renderBoundedLines(
								textLines,
								theme,
								codePreviewSettings.diffIntensity,
								allRowIndexes(textLines, nested.length > 0),
							),
						);
					}
					let preview: { auditIndex: number; body: string; hidden: number } | undefined;
					for (let index = audits.length - 1; index >= 0; index--) {
						const audit = audits[index]!;
						if (audit.tool !== "write" || audit.success === false) continue;
						const rendered = renderBody(audit, expanded ? 20 : 10);
						if (rendered) {
							preview = { auditIndex: index, ...rendered };
							break;
						}
					}
					return trackRows(
						renderSpindleMulticallPartial(
							{
								audits,
								phases,
								progress,
								expanded,
								preview,
								core: corePreviewContext,
								showNestedToolCalls,
								spinner,
							},
							theme,
							context?.invalidate,
						),
					);
				}

				const output = result.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join(nl);
				const styleOutputLines = (lines: string[]): string[] => {
					if (!details.outputFormat || lines.length === 0) {
						return lines.map((line) => theme.fg("toolOutput", line || " "));
					}
					const highlightedStart = Math.min(lines.length, details.outputFormatStartLine ?? 0);
					const highlightedCount = Math.min(
						lines.length - highlightedStart,
						details.outputFormatLines ?? lines.length,
					);
					const highlightedSource = lines.slice(highlightedStart, highlightedStart + highlightedCount);
					const highlighted =
						highlightedSource.length > 0
							? highlightCode(highlightedSource.join(nl), details.outputFormat, context?.invalidate)
							: [];
					const styledPrefix =
						highlighted?.map((line) => line || " ") ??
						highlightedSource.map((line) => theme.fg("toolOutput", line || " "));
					return [
						...lines.slice(0, highlightedStart).map((line) => theme.fg("toolOutput", line || " ")),
						...styledPrefix,
						...lines
							.slice(highlightedStart + highlightedCount)
							.map((line) => theme.fg("toolOutput", line || " ")),
					];
				};
				const failed = details.success === false;

				if (audits.length === 0) {
					// Type-check failures are the one error class where the diagnosis is a
					// list, not a sentence: render each error as its own red line so the
					// user sees exactly why the program never ran (expand shows all).
					const typeErrors = details.typeErrors;
					if (failed && typeErrors !== undefined && typeErrors.length > 0) {
						const limit = expanded ? typeErrors.length : Math.min(typeErrors.length, 6);
						const shown = typeErrors.slice(0, limit);
						let text = theme.fg(
							"error",
							`✗ Type errors; code was not executed (${countLabel(typeErrors.length, "error")})`,
						);
						for (const typeError of shown) {
							const where = typeError.line > 0 ? `Line ${typeError.line}:${typeError.column}: ` : "";
							text += nl + theme.fg("error", `  ${where}${safeTerminalText(typeError.message)}`);
						}
						const hidden = typeErrors.length - shown.length;
						if (hidden > 0) {
							text += nl + theme.fg("dim", `… ${countLabel(hidden, "error")} hidden`);
							if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
						}
						return trackRows(new Text(text, 0, 0));
					}
					if (failed && details.error) {
						return trackRows(new Text(theme.fg("error", `✗ ${safeTerminalText(details.error)}`), 0, 0));
					}
					if (!output) return trackRows(new Text(theme.fg("dim", "✓ Spindle"), 0, 0));
					const lines = safeTerminalText(output).split(nl);
					const limit = expanded ? Math.min(lines.length, 200) : 12;
					const shown = lines.slice(0, limit);
					let text = styleOutputLines(shown).join(nl);
					if (lines.length > shown.length) {
						text += nl + theme.fg("dim", `… ${countLabel(lines.length - shown.length, "line")}`);
						if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
					}
					return trackRows(renderBoundedLines(text.split(nl), theme, codePreviewSettings.diffIntensity));
				}

				if (audits.length === 1) {
					const audit = audits[0]!;
					let text = nestedCallTitle(audit, theme, context?.invalidate, corePreviewContext);
					const nested = renderNestedAgentToolLines(audit, theme, {
						expanded,
						showTools: showNestedToolCalls,
						core: corePreviewContext,
						...(context?.invalidate ? { invalidate: context.invalidate } : {}),
					});
					if (audit.success === false) {
						if (audit.error) {
							text += nl + theme.fg("error", safeTerminalText(audit.error));
						}
						return trackRows(new Text(text, 0, 0));
					}
					if (nested[0]) {
						text += ` ${nested[0]}`;
						if (nested.length > 1) text += nl + nested.slice(1).join(nl);
					}
					const limit = expanded || coreToolRendererEnabled(audit, codePreviewSettings) ? 200 : 12;
					const rendered = nested.length > 0 ? null : renderBody(audit, limit);
					if (rendered) {
						text += nl + rendered.body;
						if (rendered.hidden > 0) {
							text += nl + theme.fg("dim", `… ${countLabel(rendered.hidden, "line")}`);
							if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
						}
						const readHint = modelReadHint(audits, output, theme);
						if (readHint) text += nl + readHint;
					} else if (isCoreToolAudit(audit) && !expanded && !coreToolPreviewEnabled(audit, codePreviewSettings)) {
						text += nl + theme.fg("muted", "╰─ ") + expandHint(theme);
					} else if (nested.length === 0 && output && !isCoreToolAudit(audit)) {
						const lines = safeTerminalText(output).split(nl);
						const outLimit = expanded ? Math.min(lines.length, 200) : 12;
						const outShown = lines.slice(0, outLimit);
						text += nl + styleOutputLines(outShown).join(nl);
						if (lines.length > outShown.length) {
							text += nl + theme.fg("dim", `… ${countLabel(lines.length - outShown.length, "line")}`);
							if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
						}
					}
					const textLines = text.split(nl);
					return trackRows(
						renderBoundedLines(
							textLines,
							theme,
							codePreviewSettings.diffIntensity,
							allRowIndexes(textLines, nested.length > 0),
						),
					);
				}

				const failedCalls = audits.filter((audit) => audit.success === false).length;
				const status = failed ? "failed" : "complete";
				const statusColor = failed ? "error" : "success";
				const metadata = [
					countLabel(audits.length, "nested call"),
					failedCalls > 0 ? `${failedCalls} failed` : undefined,
					phases.length > 0 ? countLabel(phases.length, "phase") : undefined,
				].filter((value): value is string => Boolean(value));
				let text = theme.fg(statusColor, `${failed ? "✗" : "✓"} Spindle ${status}`);
				if (metadata.length > 0) text += theme.fg("dim", ` · ${metadata.join(" · ")}`);
				if (phases.length > 0) text += nl + theme.fg("dim", phases.map((phase) => `◆ ${phase}`).join("  "));

				const callLimit = spindleMulticallCallLimit(expanded);
				const callsShown = audits.slice(0, callLimit);
				const callsHidden = audits.length - callsShown.length;
				let collapsedPreview: { auditIndex: number; body: string; hidden: number } | undefined;
				if (!expanded) {
					for (let index = callsShown.length - 1; index >= 0; index--) {
						const audit = callsShown[index]!;
						if (audit.tool !== "write" || audit.success === false) continue;
						const rendered = renderBody(audit, 10);
						if (rendered) {
							collapsedPreview = { auditIndex: index, ...rendered };
							break;
						}
					}
				}
				let firstNested = true;
				const textRows = text.split(nl);
				const agentWrapLineIndexes = new Set<number>();
				for (let index = 0; index < callsShown.length; index++) {
					const audit = callsShown[index]!;
					if (expanded && !firstNested) textRows.push("");
					firstNested = false;
					const glyph = audit.success === false ? theme.fg("error", "✗") : theme.fg("dim", "›");
					const nested = renderNestedAgentToolLines(audit, theme, {
						expanded,
						compact: !expanded,
						showTools: showNestedToolCalls,
						core: corePreviewContext,
						...(context?.invalidate ? { invalidate: context.invalidate } : {}),
					});
					let callRow = `${glyph} ${nestedCallTitle(audit, theme, context?.invalidate, corePreviewContext)}`;
					if (nested[0] && audit.success !== false) {
						callRow += ` ${nested[0]}`;
						if (expanded) agentWrapLineIndexes.add(textRows.length);
					}
					textRows.push(callRow);
					if (audit.success === false && audit.error) {
						textRows.push(`  ${theme.fg("error", safeTerminalText(audit.error))}`);
					} else {
						if (nested.length > 1) {
							for (const line of nested.slice(1)) {
								agentWrapLineIndexes.add(textRows.length);
								textRows.push(line);
							}
						}
						const rendered = nested.length === 0 && expanded ? renderBody(audit, 40) : null;
						if (rendered) {
							textRows.push(...rendered.body.split(nl));
							if (rendered.hidden > 0) {
								textRows.push(theme.fg("dim", `… ${countLabel(rendered.hidden, "line")}`));
							}
						} else if (nested.length === 0 && collapsedPreview?.auditIndex === index) {
							textRows.push(...collapsedPreview.body.split(nl).map((line) => `  ${line}`));
							if (collapsedPreview.hidden > 0) {
								textRows.push(theme.fg("dim", `  … ${countLabel(collapsedPreview.hidden, "line")}`));
							}
						}
					}
				}
				text = textRows.join(nl);
				if (callsHidden > 0) {
					text += nl + theme.fg("dim", `… ${countLabel(callsHidden, "nested call")} hidden`);
					if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
				}
				const readHint = modelReadHint(audits, output, theme);
				if (readHint) text += nl + readHint;

				const showOutput = failed || expanded;
				if (showOutput && output) {
					const lines = safeTerminalText(output).split(nl);
					const limit = expanded ? Math.min(lines.length, 200) : 6;
					const shown = lines.slice(0, limit);
					if (shown.length > 0) {
						if (expanded) text += nl + theme.fg("dim", "↩ return");
						text += nl + styleOutputLines(shown).join(nl);
						if (lines.length > shown.length) {
							text += nl + theme.fg("dim", `… ${countLabel(lines.length - shown.length, "line")} hidden`);
							if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
						}
					}
				}
				return trackRows(
					renderBoundedLines(text.split(nl), theme, codePreviewSettings.diffIntensity, agentWrapLineIndexes),
				);
			},
			async execute(toolCallId, params, signal, onUpdate, context) {
				await state.ensure(context);
				// Defensive: a non-strict provider may deliver code as an array of lines;
				// join before type-checking so the program runs instead of failing on a
				// non-string code param. Strict providers reject an array upstream
				// against the Type.String schema, so this branch is a no-op there.
				// prepareArguments joins code arrays, quotes unquoted pi path arguments and
				// parses a JSON-encoded `strings` map before Pi validates this call; keep
				// the same coercions here for direct internal invocations.
				const joined = Array.isArray(params.code) ? params.code.join("\n") : params.code;
				const code = repairSpindleGuestCode(joined);
				const strings = resolveSpindleExecPayloads(params);
				const runDisplay = normalizeRunDisplay(params.display);
				const result = await state.execution.execute({
					code,
					...(strings ? { strings } : {}),
					signal,
					parentToolCallId: toolCallId,
					context,
					...(params.agentBudget !== undefined ? { maxAgentCalls: params.agentBudget } : {}),
					...(params.timeoutMs !== undefined ? { requestedTimeoutMs: params.timeoutMs } : {}),
					...(runDisplay
						? {
								display: {
									...(runDisplay.name !== undefined && { name: runDisplay.name }),
									...(runDisplay.description !== undefined && { description: runDisplay.description }),
								},
							}
						: {}),
					onPartial(snapshot) {
						onUpdate?.({
							content: [{ type: "text", text: snapshot.progress ?? "" }],
							details: {
								progress: snapshot.progress,
								audits: snapshot.audits,
								phases: snapshot.phases,
								...(snapshot.stateNotes.length > 0 ? { stateNotes: snapshot.stateNotes } : {}),
							},
						});
					},
				});

				const selectedResultFormat = params.resultFormat ?? state.config.executor.resultFormat;
				const formattedValue = formatSpindleValue(result.value, selectedResultFormat);
				const failureProgress = formatFailureProgress(result.trace);
				const sections = [...result.logs];
				const logPrefix = result.logs.join("\n\n");
				if (formattedValue.text) sections.push(formattedValue.text);
				if (result.error) sections.push(`Runtime error: ${result.error}`);
				// A failed program still mutated whatever its successful calls touched;
				// name them so the model inspects before repeating the work.
				if (failureProgress) sections.push(failureProgress);
				// The other half of the τ contract: state the model cannot see is state
				// it will guess at, so every result names what the scratchpad holds.
				if (result.stateKeys && result.stateKeys.length > 0) {
					const held = result.stateKeys
						.map((entry) => `${entry.key} (${formatSessionStoreBytes(entry.bytes)})`)
						.join(", ");
					sections.push(`τ keys: ${held}`);
				}
				const rawOutput = sections.join("\n\n");
				const outputBudget = modelOutputBudget(state.config.executor.maxOutputChars, result.success);
				const outputWillTruncate = rawOutput.length > outputBudget;
				const outputFormat =
					formattedValue.language && formattedValue.text && (result.logs.length === 0 || !outputWillTruncate)
						? formattedValue.language
						: undefined;
				const outputFormatStartLine = result.logs.length > 0 ? countNewlines(logPrefix) + 2 : 0;
				const persistedDetails = createSpindlePersistedExecutionDetails({
					...result,
					...(outputFormat ? { outputFormat, outputFormatStartLine } : {}),
					...(outputFormat
						? {
								outputFormatLines:
									formattedValue.highlightedLineCount ?? countNewlines(formattedValue.text) + 1,
							}
						: {}),
				});

				if (result.typeErrors) {
					const text = result.typeErrors
						.map((error) =>
							error.line > 0 ? `Line ${error.line}:${error.column}: ${error.message}` : error.message,
						)
						.join("\n");
					const recoveryHint = typeErrorRecoveryHint(code, result.typeErrors);
					const bounded = await boundModelOutput(
						`Type errors; code was not executed:\n${text}${recoveryHint ? `\n\n${recoveryHint}` : ""}`,
						outputBudget,
					);
					return {
						content: [{ type: "text", text: bounded.text }],
						details: persistedDetails,
						isError: true,
					};
				}

				// Oversized output spills to a temp artifact instead of vanishing in the
				// middle of a truncation, so the full text stays reachable by path.
				const output = (await boundModelOutput(rawOutput || "(no output)", outputBudget)).text;
				const terminate =
					result.success &&
					typeof result.value === "object" &&
					result.value !== null &&
					"terminate" in result.value &&
					result.value.terminate === true;
				// A nested `pi.read` of an image returns image content blocks that
				// normalizeResult stripped (the sandbox holds text only). The provider
				// handed them out-of-band to each call audit; re-attach them here so
				// pi core's ToolExecutionComponent renders a kitty image preview — the
				// same path a native `read` takes — for single-call AND multitool
				// reads. pi-vision-handoff keeps the image in the nested tool_result
				// (its `context` hook swaps image→description on the LLM-bound
				// spindle_exec clone), so every read audit carries its image here.
				const mediaBlocks: SpindleMediaBlock[] = [];
				for (const audit of result.audits) {
					if (audit.media) mediaBlocks.push(...audit.media);
				}
				const singleAudit = result.audits.length === 1 ? result.audits[0] : undefined;
				// The read tool's own text note (e.g. "Read image file [image/png]"),
				// captured after the handoff stripped pi's non-vision note. Used as
				// the single-call body + content text so the preview shows the kitty
				// image + the clean note (like pi core) instead of the handoff's
				// verbose description. Multitool renders each read's note as its own
				// call body, so the joined program return suffices as the content text
				// there.
				const mediaNote = singleAudit?.mediaNote;
				// The base64 payload now lives in the result content; discard the
				// duplicate in-memory audit copies before returning.
				for (const audit of result.audits) {
					delete audit.media;
					delete audit.mediaNote;
				}
				const content: Array<{ type: "text"; text: string } | SpindleMediaBlock> = [];
				if (mediaBlocks.length > 0) {
					// Mirror a native `read`: keep the image block(s) for pi core's kitty
					// render alongside the short note. The handoff's `context` hook
					// swaps each image for its description on the LLM-bound clone, so the
					// text-only model still receives the description while the terminal
					// shows the kitty image.
					const textOutput = singleAudit && mediaNote ? mediaNote : output === "(no output)" ? "" : output;
					if (textOutput) content.push({ type: "text", text: textOutput });
					for (const block of mediaBlocks) content.push(block);
					if (singleAudit && mediaNote) {
						singleAudit.result = mediaNote;
					}
				} else {
					content.push({ type: "text", text: output });
				}
				return {
					content,
					details: persistedDetails,
					...(result.usage ? { usage: result.usage } : {}),
					...(terminate ? { terminate: true } : {}),
					...(result.success ? {} : { isError: true }),
				};
			},
		}),
		{
			mode: codePreviewSettings.toolCallBackground,
			toolCallTiming: codePreviewSettings.toolCallTiming,
		},
	);
