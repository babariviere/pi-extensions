import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
	contextArtifact?: { path: string; hash: string; artifactId?: string };
	runtime: PreparedRuntimeProfile;
	rolePromptPath: string;
	limits: Parameters<typeof buildSystemdRunArgs>[0]["limits"];
	unit?: string;
	model?: string;
	prompt?: string;
	command?: string;
	commandArgsPrefix?: string[];
	preflight?: HostPreflightOptions;
	security?: "agent" | "verifier";
	inaccessiblePaths?: readonly string[];
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
	const args = ["--print", "--print-turn", "--session", join(options.runtime.sessionDir, "session.jsonl")];
	const model = modelArg(options.runtime, options.model);
	if (model) args.push("--model", model);
	if (options.runtime.thinking !== "off") args.push("--thinking", options.runtime.thinking);
	if (options.runtime.tools.length === 0) args.push("--no-tools");
	else args.push("--tools", options.runtime.tools.join(","));
	const suppliedPrompt = options.prompt ?? `Perform the assigned ${options.role} task.`;
	const prompt = suppliedPrompt.includes(contextPath)
		? suppliedPrompt
		: `${suppliedPrompt} Read the persisted context manifest at ${contextPath} before acting.`;
	args.push("--append-system-prompt", options.rolePromptPath, "--no-context-files", "--no-approve", "--", prompt);
	return args;
}

function persistLaunchIntent(options: HerdrAttemptOptions, unit: string): string {
	const path = join(options.attemptDirectory, "launch-intent.json");
	const content = `${JSON.stringify({
		version: 1,
		attemptId: options.attemptId,
		unit,
		worktree: options.worktreeDirectory,
	})}\n`;
	mkdirSync(options.attemptDirectory, { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, content, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
	chmodSync(path, 0o600);
	options.database.createArtifact({
		caseId: options.caseId,
		attemptId: options.attemptId,
		kind: "launch-intent",
		path,
		metadata: { version: 1, unit, worktree: options.worktreeDirectory },
	});
	return path;
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
	const contextArtifact =
		options.contextArtifact ??
		persistContextManifest(options.context, {
			attemptDirectory: options.attemptDirectory,
			database: options.database,
		});
	const unit = options.unit ?? `background-agent-${options.attemptId}`;
	persistLaunchIntent(options, unit);
	options.database.run(
		"UPDATE attempts SET systemd_unit = ?, worktree = ? WHERE id = ?",
		unit,
		options.worktreeDirectory,
		options.attemptId,
	);
	const childArgs = piArgs(options, contextArtifact.path);
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
			piArgs: [...(options.commandArgsPrefix ?? []), ...childArgs],
			limits: options.limits,
			...(options.security ? { security: options.security } : {}),
			...(options.inaccessiblePaths ? { inaccessiblePaths: options.inaccessiblePaths } : {}),
			...(options.command ? { command: options.command } : {}),
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
	if (!tab?.tabId) throw new Error("Herdr did not return a tab");
	options.database.run(
		"UPDATE attempts SET systemd_unit = ?, tab_id = ?, worktree = ? WHERE id = ?",
		unit,
		tab.tabId,
		options.worktreeDirectory,
		options.attemptId,
	);
	if (!tab.rootPaneId) {
		await host.closeTab(tab.tabId);
		throw new Error("Herdr did not return a root pane");
	}
	options.database.run(
		"UPDATE attempts SET systemd_unit = ?, tab_id = ?, pane_id = ?, worktree = ? WHERE id = ?",
		unit,
		tab.tabId,
		tab.rootPaneId,
		options.worktreeDirectory,
		options.attemptId,
	);
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
