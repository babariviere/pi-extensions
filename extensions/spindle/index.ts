/**
 * LOCAL REWRITE of upstream `src/index.ts`.
 *
 * Spindle registers exactly one tool (`spindle_exec`) and one widget
 * (`aboveEditor`). Upstream's actor host-event observers, `/spindle` command,
 * prewalk handoff boundary, compaction hook, ESC halt-the-world gate and the
 * bundled-skills `resources_discover` contribution all belong to dropped
 * subsystems and are gone.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSandboxMode, SANDBOX_MODES } from "./sandbox/policy.ts";
import { SANDBOX_STATE_EVENT, type SandboxStateEvent } from "./sandbox/protocol.ts";

/** Footer key for the sandbox indicator. */
const SANDBOX_STATUS_KEY = "spindle-sandbox";
import { loadCodePreviewSettings } from "./ui/code-preview.ts";
import { type SpindleToolShellDecorator, withCodePreviewShell } from "./ui/code-preview-shell.ts";
import { cleanupOldRuns } from "./agents/paths.ts";
import { CapturedToolCatalog } from "./capture/catalog.ts";
import { installRegisteredToolCapture } from "./capture/interceptor.ts";
import { DEFAULT_SPINDLE_CONFIG, effectiveToolCaptureConfig } from "./config.ts";
import { SpindleToolLifecycle, SpindleToolOwnership, ownsSpindleToolSource } from "./core/tool-ownership.ts";
import { expandSkillDirMarkersForRead, expandSkillDirMarkersInSkillBlock } from "./core/skill-dir.ts";
import { restoreSkillsForFullCodePrompt } from "./core/skill-prompt.ts";
import { buildSkillReferenceGuidance } from "./core/skill-references.ts";
import { createSpindleExecTool } from "./spindle-exec-tool.ts";
import { SpindleState } from "./spindle-state.ts";
import { piHostCompatibilityWarning } from "./host-compatibility.ts";
import { SPINDLE_PROVIDER_REGISTER_EVENT, type SpindleProviderRegistration } from "./protocol.ts";
import { SpindleUiController } from "./ui/controller.ts";
import { configureHighlighting } from "./ui/highlight.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SPINDLE_EXTENSION_ENTRY_PATH = path.resolve(fileURLToPath(import.meta.url));

const FULL_CODE_GUIDANCE =
	"Spindle full code mode: `spindle_exec` is the only way to call Pi core tools — use them as `pi.*` inside `code`.\n" +
	"Examples and returns: `pi.read('/x')`, `pi.grep('TODO','src')` / `pi.grep({regex:'TODO', ic:true, ctx:2})`, `pi.find('*.ts','src')`, and `pi.ls('src')` return strings; `pi.bash({cmd:'ls'})`, `pi.edit({path:'/x', old:'a', new:'b'})`, and `pi.write({path:'/y', text:'z'})` return `{ok, output, details}` (read `.output`); failed core calls reject, including `bash` on an ordinary nonzero exit; pass `settle: true` to `pi.bash` to get `{ ok: false, exitCode, output, error }` instead. `pi.bash` also accepts per-call `cwd` (absolute), `env` (merged over the shell environment), and `stdin` (piped text: `pi.bash({ command: 'ssh host bash -s', stdin: π.script })`); `process.env` holds an allowlisted host env snapshot (HOME, USER, SHELL, PWD, PATH, LANG, LC_*, TERM, TMPDIR, XDG_*) and `process.cwd()` the session directory. Timeout, cancellation, approval, and security failures still reject.\n" +
	"Other namespaces: `extensions.<tool>(args)` for tools registered by sibling extensions; `tools.list()` / `tools.search({query})` / `tools.describe({ref})` / `tools.providers()` / `tools.catalog()` discover actions across every provider and `tools.call({ref, args})` invokes a ref computed at runtime; `mcp.call(server, tool, args)` plus `mcp.list()` / `mcp.search()` / `mcp.describe()` (and the sugar `mcp.<server>.<tool>(args)`) for MCP; `agents.list()` / `agents.run({agent, task})` / `agents.runAll({tasks})` for custom markdown subagents. `workflow.parallel` / `workflow.pipeline` / `workflow.phase` structure long programs. `print(...)` logs; `π.<key>` reads the `strings` parameter (it is not a tool).";

const ORCHESTRATION_ONLY_GUIDANCE =
	"Spindle is in orchestration-only mode. Pi core and registered extension tools stay on their native direct execution path; inside `spindle_exec`, `pi.*` and `extensions.*` are unavailable. Use `mcp.*`, `agents.*`, `workflow.*`, `print`, and `π` only.";

const registrationFrom = (value: unknown): SpindleProviderRegistration | undefined => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const registration = value as Partial<SpindleProviderRegistration>;
	const provider = registration.provider;
	if (
		registration.version !== 1 ||
		typeof provider !== "object" ||
		provider === null ||
		typeof provider.name !== "string" ||
		typeof provider.description !== "string" ||
		typeof provider.list !== "function" ||
		typeof provider.describe !== "function" ||
		typeof provider.invoke !== "function"
	) {
		return undefined;
	}
	return registration as SpindleProviderRegistration;
};

export default async function spindle(pi: ExtensionAPI): Promise<void> {
	const codePreviewSettings = await loadCodePreviewSettings();
	const decorateShell: SpindleToolShellDecorator = withCodePreviewShell;
	let compatibilityWarningShown = false;
	configureHighlighting(codePreviewSettings.shikiTheme, codePreviewSettings.syntaxHighlighting);
	const capturedTools = new CapturedToolCatalog();
	const state = new SpindleState(pi, capturedTools);
	const toolOwnership = new SpindleToolOwnership(pi);
	const spindleUi = new SpindleUiController(state, codePreviewSettings);

	const unsubscribeProviderRegistration = pi.events.on(SPINDLE_PROVIDER_REGISTER_EVENT, (value: unknown) => {
		const registration = registrationFrom(value);
		if (!registration) throw new Error("Invalid Spindle provider registration");
		state.registerExternal(
			registration.provider,
			registration.overwrite === undefined ? {} : { overwrite: registration.overwrite },
		);
	});

	const spindleTool = createSpindleExecTool(state, codePreviewSettings, decorateShell);
	const spindleToolLifecycle = new SpindleToolLifecycle(() =>
		ownsSpindleToolSource(pi.getAllTools(), SPINDLE_EXTENSION_ENTRY_PATH),
	);

	const inactiveCapturePolicy = {
		...structuredClone(DEFAULT_SPINDLE_CONFIG.capture),
		enabled: false,
		hideFromModel: false,
	};
	const toolCapture = await installRegisteredToolCapture({
		anchorDefinition: spindleTool,
		catalog: capturedTools,
		initialPolicy: inactiveCapturePolicy,
	});
	pi.registerTool(spindleTool);

	const applySpindleMode = (): void => {
		toolCapture.setPolicy(effectiveToolCaptureConfig(state.config));
		pi.registerTool(spindleTool);
		toolOwnership.apply(state.config.fullCodeMode);
	};
	const suspendToolCapture = (): void => {
		toolCapture.setPolicy(inactiveCapturePolicy);
	};

	pi.on("session_start", async (_event, context) => {
		spindleUi.stop();
		suspendToolCapture();
		if (!compatibilityWarningShown) {
			compatibilityWarningShown = true;
			const warning = piHostCompatibilityWarning();
			if (warning) {
				console.warn(`[spindle] ${warning}`);
				if (context.hasUI) context.ui.notify(warning, "warning");
			}
		}
		const projectTrusted = typeof context.isProjectTrusted === "function" ? context.isProjectTrusted() : true;
		try {
			Object.assign(codePreviewSettings, await loadCodePreviewSettings(context.cwd, projectTrusted));
			configureHighlighting(codePreviewSettings.shikiTheme, codePreviewSettings.syntaxHighlighting);
			Object.assign(spindleTool, createSpindleExecTool(state, codePreviewSettings, decorateShell));
		} catch (error) {
			console.warn("[spindle] Failed to refresh code preview settings.", error);
		}
		await state.initialize(context);
		applySpindleMode();
		spindleUi.start(context);
		sandboxContext = context;
		renderSandboxStatus(context, state.sandboxState());
		// Throttled, best-effort prune of stale persisted subagent runs so they do
		// not accumulate forever next to the parent sessions.
		try {
			cleanupOldRuns(state.sessionRef.sessionFile);
		} catch {
			// Cleanup is housekeeping; never let it break session startup.
		}
	});

	// ── sandbox command ──────────────────────────────────────────────────

	/**
	 * Latest session context, so the status indicator can be refreshed from an
	 * event handler (a night run turning enforcement on) and not only from a
	 * command invocation.
	 */
	let sandboxContext: ExtensionContext | undefined;

	const renderSandboxStatus = (context: ExtensionContext, state: SandboxStateEvent | undefined): void => {
		if (!state?.enforcing) {
			context.ui.setStatus(SANDBOX_STATUS_KEY, undefined);
			return;
		}
		// "paths only" matters: it is the difference between the kernel refusing a
		// write and Spindle refusing one it can see.
		const degraded = state.osEnforced ? "" : " (paths only)";
		context.ui.setStatus(SANDBOX_STATUS_KEY, context.ui.theme.fg("accent", `\u{1F512} ${state.mode}${degraded}`));
	};

	pi.events.on(SANDBOX_STATE_EVENT, (payload) => {
		const context = sandboxContext;
		if (!context) return;
		renderSandboxStatus(context, payload as SandboxStateEvent);
	});

	pi.registerCommand("sandbox", {
		description:
			"Filesystem sandbox for this session (status | off | read-only | workspace-write | full [extra writable paths])",
		getArgumentCompletions: (prefix) =>
			["status", ...SANDBOX_MODES]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, context) => {
			sandboxContext = context;
			const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);

			if (!action || action === "status") {
				const current = state.sandboxState();
				const lines = [
					`spindle sandbox: ${state.sandboxStatus()}`,
					current ? `mode: ${current.mode} (source: ${current.source})` : "mode: unavailable",
					`held by night run: ${state.sandboxHeldByNightRun() ? "yes" : "no"}`,
					"",
					"Change it with: /sandbox read-only | workspace-write | off",
				];
				context.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (!isSandboxMode(action)) {
				context.ui.notify(
					`spindle: unknown sandbox mode '${action}'. Use one of: ${SANDBOX_MODES.join(", ")}.`,
					"error",
				);
				return;
			}

			// `off` is a revert to spindle.json rather than a forced "no enforcement",
			// so it cannot loosen what the config (or a night run) asks for.
			const applied = await state.applySandboxRequest(
				action === "off" ? null : { mode: action, ...(rest.length ? { allowWrite: rest } : {}) },
				"requested via /sandbox",
				context,
			);
			if (!applied) {
				context.ui.notify("spindle: no sandbox in this session (full code mode is off)", "warning");
				return;
			}
			renderSandboxStatus(context, applied);
		},
	});

	pi.on("tool_call", (event) => spindleToolLifecycle.toolCall(event));

	// Pi 0.80.6 intentionally ignores `isError` returned by custom-tool
	// execute(). Repair the finalized outer result through official middleware.
	pi.on("tool_result", (event) => spindleToolLifecycle.toolResult(event));

	pi.on("tool_result", (event, context) => {
		if (event.toolName !== "read" || event.isError) return undefined;
		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text") return part;
			const text = expandSkillDirMarkersForRead(part.text, event.input, context.cwd);
			if (text === part.text) return part;
			changed = true;
			return { ...part, text };
		});
		return changed ? { content } : undefined;
	});

	pi.on("context", (event) => {
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role !== "user") return message;
			if (typeof message.content === "string") {
				const content = expandSkillDirMarkersInSkillBlock(message.content);
				if (content === message.content) return message;
				changed = true;
				return { ...message, content };
			}
			let messageChanged = false;
			const content = message.content.map((part) => {
				if (part.type !== "text") return part;
				const text = expandSkillDirMarkersInSkillBlock(part.text);
				if (text === part.text) return part;
				changed = true;
				messageChanged = true;
				return { ...part, text };
			});
			return messageChanged ? { ...message, content } : message;
		});
		return changed ? { messages } : undefined;
	});

	pi.on("before_agent_start", async (event) => {
		const fullCodeMode = state.initialized ? state.config.fullCodeMode : DEFAULT_SPINDLE_CONFIG.fullCodeMode;
		if (!pi.getActiveTools().includes("spindle_exec")) return;
		const skills = event.systemPromptOptions.skills ?? [];
		// Pi omits its entire skill catalog when the active tool set lacks a tool
		// named read. Restore that catalog in full code mode with only the loader
		// instruction adapted to Spindle's nested pi.read path.
		const systemPrompt = fullCodeMode
			? restoreSkillsForFullCodePrompt(event.systemPrompt, skills)
			: event.systemPrompt;
		// Pi expands the invoked skill into the user message, but wrappers may
		// delegate by name. Resolve only explicit invocation lines so full code
		// mode preserves Pi's progressive skill loading without exposing read.
		const skillReferenceGuidance = fullCodeMode ? buildSkillReferenceGuidance(event.prompt, skills) : undefined;
		const guidance =
			(fullCodeMode ? FULL_CODE_GUIDANCE : ORCHESTRATION_ONLY_GUIDANCE) +
			(skillReferenceGuidance ? `\n\n${skillReferenceGuidance}` : "");
		return {
			systemPrompt: `${systemPrompt}\n\n${guidance}`,
		};
	});

	pi.on("session_shutdown", async () => {
		unsubscribeProviderRegistration();
		try {
			spindleUi.stop();
			suspendToolCapture();
			toolOwnership.release();
			spindleToolLifecycle.clear();
			await state.shutdown();
		} finally {
			toolCapture.dispose();
		}
	});
}

export * from "./audit/index.ts";
export * from "./protocol.ts";
