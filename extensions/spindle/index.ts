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
/** Footer key for the MCP connection indicator. */
const MCP_STATUS_KEY = "spindle-mcp";
import { loadCodePreviewSettings } from "./ui/code-preview.ts";
import { type SpindleToolShellDecorator, withCodePreviewShell } from "./ui/code-preview-shell.ts";
import { cleanupOldRuns } from "./agents/paths.ts";
import { registerTaskFileFlag, taskDeliveryFor } from "./agents/task-delivery.ts";
import { CapturedToolCatalog } from "./capture/catalog.ts";
import { authorizeMcpServer, logoutMcpServer } from "./mcp/auth-flow.ts";
import { loadMcpServerConfig } from "./mcp/server-config.ts";
import { formatMcpFooterStatus, formatMcpStatus, formatMcpTools, mcpFooterSummary } from "./mcp/status-report.ts";
import { installRegisteredToolCapture } from "./capture/interceptor.ts";
import { DEFAULT_SPINDLE_CONFIG, effectiveToolCaptureConfig } from "./config.ts";
import { SpindleToolLifecycle, SpindleToolOwnership, ownsSpindleToolSource } from "./core/tool-ownership.ts";
import { expandSkillDirMarkersForRead, expandSkillDirMarkersInSkillBlock } from "./core/skill-dir.ts";
import { restoreSkillsForFullCodePrompt } from "./core/skill-prompt.ts";
import { buildSkillReferenceGuidance } from "./core/skill-references.ts";
import { coreOverridePromptGuidance } from "./core/core-override-guidance.ts";
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
	"Spindle full code mode: call Pi tools only through `spindle_exec`, using `pi.*` inside `code`. Search the repository before reading: `pi.find` locates files, `pi.grep` locates text, and `pi.ls` shows structure. Read only identified ranges with `pi.read({path, offset, limit})`; avoid whole-file reads of large, generated, vendored, log, and lock files. Return compact findings, not raw search output or file contents.\n" +
	'Read tools return text. `pi.bash`, `pi.exec`, `pi.edit`, and `pi.write` return `{ok, output, details}`. Use `pi.exec({argv})` when arguments contain quotes, spaces, or syntax that must not be parsed by a shell; reserve `pi.bash` for shell syntax. Use `payloads` and `π.key` for multiline values. If a task names an external service or needs web research, discover tools before declaring it unavailable: `tools.search({query:"web search"})` finds registered tools, while `mcp.list()` or `mcp.search({query})` finds lazy MCP services. Connect the selected server if needed, then search and describe its action before `mcp.call`. Use `agents.*` for subagents.';

const ORCHESTRATION_ONLY_GUIDANCE =
	"Spindle is in orchestration-only mode. Pi core and registered extension tools stay on their native direct execution path; inside `spindle_exec`, `pi.*` and `extensions.*` are unavailable. Use `mcp.*`, `agents.*`, `mapLimit`, `print`, `π` and `τ` only.";

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

	// A subagent's task arrives as a file path rather than as typed input (see
	// `agents/task-delivery.ts`). Registered here, in Spindle itself, so it works
	// for every child - including one with no `sandbox:`, which gets no injected
	// child extension.
	registerTaskFileFlag(pi);
	const deliverTask = taskDeliveryFor(pi);

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

	pi.on("session_start", async (event, context) => {
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
		state.onMcpStatusChange(() => {
			if (sandboxContext) renderMcpStatus(sandboxContext);
		});
		renderMcpStatus(context);
		// Throttled, best-effort prune of stale persisted subagent runs so they do
		// not accumulate forever next to the parent sessions.
		try {
			cleanupOldRuns(state.sessionRef.sessionFile);
		} catch {
			// Cleanup is housekeeping; never let it break session startup.
		}
		// Last: a subagent's task starts a turn, so the sandbox floor, tool mode and
		// UI have to be in place before it lands. No-op unless this process was
		// launched with `--spindle-task-file`.
		deliverTask(event.reason);
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
		// "bash refused" matters: with no OS sandbox up, bash no longer runs at
		// all in an enforcing mode (see sandbox/controller.ts), it does not fall
		// back to running unsandboxed.
		const degraded = state.osEnforced ? "" : " (bash refused)";
		context.ui.setStatus(SANDBOX_STATUS_KEY, context.ui.theme.fg("accent", `\u{1F512} ${state.mode}${degraded}`));
	};

	/**
	 * Footer indicator for MCP: how many configured servers this session actually
	 * holds a connection to. Reading it never connects anything, so the count
	 * starts at 0 and rises as lazy connects happen.
	 */
	const renderMcpStatus = (context: ExtensionContext): void => {
		let summary: ReturnType<typeof mcpFooterSummary>;
		try {
			summary = mcpFooterSummary(state.mcpClient(context.cwd).status());
		} catch {
			summary = undefined;
		}
		if (!summary) {
			context.ui.setStatus(MCP_STATUS_KEY, undefined);
			return;
		}
		const color = summary.failed > 0 ? "error" : summary.needsAuth > 0 ? "warning" : "dim";
		context.ui.setStatus(MCP_STATUS_KEY, context.ui.theme.fg(color, formatMcpFooterStatus(summary)));
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

	// `/mcp` and `/mcp-auth`. These used to come from pi-mcp-adapter; with the
	// in-tree client they have to come from here, and `/mcp-auth` is the ONLY
	// path in spindle that may open a consent screen (see mcp/auth-flow.ts).
	const mcpSubcommands = [
		{ value: "status", label: "status — servers, states and tool counts" },
		{ value: "tools", label: "tools [server] — cached tools" },
		{ value: "connect", label: "connect <server> — connect and refresh tools" },
		{ value: "logout", label: "logout <server> — forget stored credentials" },
	];
	const mcpServerNames = (cwd: string): string[] => {
		try {
			return loadMcpServerConfig(cwd).servers.map((server) => server.name);
		} catch {
			return [];
		}
	};
	const completeMcpArguments = (prefix: string) => {
		const normalized = prefix.trimStart();
		const withSubcommand = normalized.match(/^(\S+)\s+(.*)$/);
		if (!withSubcommand) {
			return mcpSubcommands.filter((entry) => entry.value.startsWith(normalized));
		}
		const [, subcommand = "", serverPrefix = ""] = withSubcommand;
		if (subcommand === "status") return [];
		return mcpServerNames(process.cwd())
			.filter((name) => name.startsWith(serverPrefix))
			.map((name) => ({ value: `${subcommand} ${name}`, label: name }));
	};

	pi.registerCommand("mcp", {
		description: "MCP servers from mcp.json (status | tools [server] | connect <server> | logout <server>)",
		getArgumentCompletions: completeMcpArguments,
		handler: async (args, context) => {
			const [subcommand = "status", serverName] = args.trim().split(/\s+/).filter(Boolean);
			const hub = state.mcpClient(context.cwd);
			try {
				if (subcommand === "status") {
					const config = loadMcpServerConfig(context.cwd);
					context.ui.notify(formatMcpStatus(hub.status(), config.errors), "info");
					return;
				}
				if (subcommand === "tools") {
					context.ui.notify(formatMcpTools(await hub.listTools(serverName), serverName), "info");
					return;
				}
				if (subcommand === "connect") {
					if (!serverName) {
						context.ui.notify("spindle: /mcp connect <server>", "warning");
						return;
					}
					const status = await hub.connect(serverName);
					context.ui.notify(`MCP '${status.name}': ${status.state}, ${status.tools ?? 0} tool(s) cached.`, "info");
					return;
				}
				if (subcommand === "logout") {
					if (!serverName) {
						context.ui.notify("spindle: /mcp logout <server>", "warning");
						return;
					}
					logoutMcpServer(serverName);
					context.ui.notify(
						`Cleared stored credentials for '${serverName}'. Run /mcp-auth ${serverName} to authorize again.`,
						"info",
					);
					return;
				}
				context.ui.notify(
					`spindle: unknown /mcp subcommand '${subcommand}'. Use status, tools, connect or logout.`,
					"error",
				);
			} catch (error) {
				context.ui.notify(`spindle: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				renderMcpStatus(context);
			}
		},
	});

	pi.registerCommand("mcp-auth", {
		description: "Authorize an MCP server with OAuth in a browser",
		getArgumentCompletions: (prefix) =>
			mcpServerNames(process.cwd())
				.filter((name) => name.startsWith(prefix.trimStart()))
				.map((name) => ({ value: name, label: name })),
		handler: async (args, context) => {
			const serverName = args.trim().split(/\s+/).filter(Boolean)[0];
			if (!serverName) {
				const names = mcpServerNames(context.cwd);
				context.ui.notify(
					names.length > 0
						? `spindle: /mcp-auth <server> — one of: ${names.join(", ")}`
						: "spindle: no MCP server is configured",
					"warning",
				);
				return;
			}
			try {
				const result = await authorizeMcpServer({
					cwd: context.cwd,
					serverName,
					notify: (message) => context.ui.notify(message, "info"),
				});
				// Connect right away: it proves the token works and warms the schema
				// cache, so discovery and the typed guest surface are useful at once.
				const status = await state.mcpClient(context.cwd).connect(serverName);
				context.ui.notify(
					`MCP '${serverName}' ${result.state === "refreshed" ? "was already authorized" : "authorized"}: ${status.tools ?? 0} tool(s) cached.`,
					"info",
				);
			} catch (error) {
				context.ui.notify(`spindle: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
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
		// An extension that overrides a core tool by exact name keeps its authored
		// guidance: in full code mode the override is only reachable as `pi.<name>`,
		// so its own prompt text would otherwise never be shown.
		const overrideGuidance = fullCodeMode ? coreOverridePromptGuidance(capturedTools).trim() : "";
		const guidance =
			(fullCodeMode ? FULL_CODE_GUIDANCE : ORCHESTRATION_ONLY_GUIDANCE) +
			(overrideGuidance ? `\n\n${overrideGuidance}` : "") +
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
