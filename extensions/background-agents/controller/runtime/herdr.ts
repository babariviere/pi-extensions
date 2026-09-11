import { join } from "node:path";
import type { HerdrTab } from "../../../spindle/agents/herdr-parse.ts";
import { herdr as defaultHerdr, type HerdrClient } from "../../../spindle/agents/herdr-client.ts";
import type { BackgroundAgentsDatabase } from "../database.ts";
import type { AgentRole } from "../../types.ts";
import { persistContextManifest, type ContextManifest } from "./context.ts";
import { prepareRuntimeProfile, type PreparedRuntimeProfile } from "./profiles.ts";
import { assertLinuxHostPreflight, buildSystemdRunArgs, type HostPreflightOptions } from "./systemd.ts";

export interface HerdrAttemptOptions {
	database: BackgroundAgentsDatabase;
	attemptId: string;
	caseId: string;
	role: AgentRole;
	attemptDirectory: string;
	worktreeDirectory: string;
	primaryCheckout: string;
	gitDirectory: string;
	context: ContextManifest;
	runtime: PreparedRuntimeProfile;
	rolePromptPath: string;
	limits: Parameters<typeof buildSystemdRunArgs>[0]["limits"];
	unit?: string;
	model?: string;
	prompt?: string;
	preflight?: HostPreflightOptions;
}

export interface HerdrAttemptHost {
	createTab(label: string, workspaceId?: string, cwd?: string): Promise<HerdrTab | undefined>;
	waitForShellReady(paneId: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }>;
	runCommand(paneId: string, argv: string[], signal?: AbortSignal): Promise<{ ok: boolean; error?: string }>;
	closeTab(tabId: string): Promise<void>;
}

export interface HerdrAttemptLaunchResult {
	attemptId: string;
	unit: string;
	tabId: string;
	paneId: string;
	contextPath: string;
	command: string[];
}

function modelArg(runtime: PreparedRuntimeProfile, override?: string): string | undefined {
	const model = override ?? runtime.model;
	if (!model) return undefined;
	if (runtime.profile.allowedModels.length > 0 && !runtime.profile.allowedModels.includes(model))
		throw new Error(`model ${model} is not allowed by profile ${runtime.profile.id}`);
	return model.includes("/") ? model : `${runtime.profile.provider}/${model}`;
}

function piArgs(options: HerdrAttemptOptions, contextPath: string): string[] {
	const args = ["--session", join(options.runtime.sessionDir, "session.jsonl")];
	const model = modelArg(options.runtime, options.model);
	if (model) args.push("--model", model);
	if (options.runtime.thinking !== "off") args.push("--thinking", options.runtime.thinking);
	if (options.runtime.tools.length === 0) args.push("--no-tools");
	else args.push("--tools", options.runtime.tools.join(","));
	args.push(
		"--append-system-prompt",
		options.rolePromptPath,
		"--no-context-files",
		"--no-approve",
		"--",
		options.prompt ?? `Read the context manifest at ${contextPath} and perform the assigned ${options.role} task.`,
	);
	return args;
}

/** Launch a durable attempt in a fresh Herdr pane and a transient systemd service. */
export async function launchAttemptThroughHerdr(
	options: HerdrAttemptOptions,
	dependencies: {
		herdr?: HerdrAttemptHost;
		preflight?: (options: HostPreflightOptions) => Promise<void>;
		readyTimeoutMs?: number;
	} = {},
): Promise<HerdrAttemptLaunchResult> {
	const runtime = options.runtime;
	const contextArtifact = persistContextManifest(options.context, {
		attemptDirectory: options.attemptDirectory,
		database: options.database,
	});
	const unit = options.unit ?? `background-agent-${options.attemptId}`;
	const command = [
		"systemd-run",
		...buildSystemdRunArgs({
			unit,
			workingDirectory: options.worktreeDirectory,
			attemptDirectory: options.attemptDirectory,
			worktreeDirectory: options.worktreeDirectory,
			primaryCheckout: options.primaryCheckout,
			gitDirectory: options.gitDirectory,
			profileDirectory: runtime.agentDir,
			sessionDirectory: runtime.sessionDir,
			piArgs: piArgs(options, contextArtifact.path),
			limits: options.limits,
		}),
	];
	const preflight = dependencies.preflight ?? assertLinuxHostPreflight;
	await preflight({
		...(options.preflight ?? {}),
		paths: [
			options.primaryCheckout,
			options.gitDirectory,
			options.attemptDirectory,
			options.worktreeDirectory,
			runtime.agentDir,
			runtime.sessionDir,
			...(options.preflight?.paths ?? []),
		],
		credentialFiles: [...runtime.credentialFiles, ...(options.preflight?.credentialFiles ?? [])],
	});
	const host = dependencies.herdr ?? (defaultHerdr as unknown as HerdrAttemptHost);
	const tab = await host.createTab(
		`background ${options.caseId} ${options.role}`,
		undefined,
		options.worktreeDirectory,
	);
	if (!tab?.rootPaneId) throw new Error("Herdr did not return a root pane");
	const ready = await host.waitForShellReady(tab.rootPaneId, dependencies.readyTimeoutMs ?? 10_000);
	if (!ready.ok) {
		await host.closeTab(tab.tabId);
		throw new Error(`Herdr pane is not ready: ${ready.error ?? "unknown error"}`);
	}
	const launched = await host.runCommand(tab.rootPaneId, command);
	if (!launched.ok) {
		await host.closeTab(tab.tabId);
		throw new Error(`systemd service launch failed: ${launched.error ?? "unknown error"}`);
	}
	options.database.run(
		"UPDATE attempts SET systemd_unit = ?, pane_id = ?, worktree = ? WHERE id = ?",
		unit,
		tab.rootPaneId,
		options.worktreeDirectory,
		options.attemptId,
	);
	return {
		attemptId: options.attemptId,
		unit,
		tabId: tab.tabId,
		paneId: tab.rootPaneId,
		contextPath: contextArtifact.path,
		command,
	};
}

export function runtimeFromSelection(selected: Parameters<typeof prepareRuntimeProfile>[0]): PreparedRuntimeProfile {
	return prepareRuntimeProfile(selected);
}

export const launchDurableAttempt = launchAttemptThroughHerdr;
