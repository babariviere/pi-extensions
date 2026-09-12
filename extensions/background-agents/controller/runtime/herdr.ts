import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HerdrTab } from "../../../code-mode/agents/herdr-parse.ts";
import { herdr as defaultHerdr, type HerdrClient } from "../../../code-mode/agents/herdr-client.ts";
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
	listTabs?(workspaceId?: string): Promise<HerdrTab[]>;
	waitForShellReady(paneId: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }>;
	runCommand(paneId: string, argv: string[], signal?: AbortSignal): Promise<{ ok: boolean; error?: string }>;
	closeTab(tabId: string): Promise<void>;
	isTabClosed?(tabId: string): Promise<boolean>;
	stopSystemdUnit?(unit: string): Promise<void>;
}

async function closeTabOrConfirmAbsence(host: HerdrAttemptHost, tabId: string): Promise<boolean> {
	try {
		await host.closeTab(tabId);
		return true;
	} catch {
		if (!host.isTabClosed) return false;
		try {
			return await host.isTabClosed(tabId);
		} catch {
			return false;
		}
	}
}

async function reconcileAmbiguousTabCreation(host: HerdrAttemptHost, label: string): Promise<string | undefined> {
	if (!host.listTabs) throw new Error("Herdr tab listing is unavailable for ambiguous creation");
	const matches = (await host.listTabs()).filter((tab) => tab.label === label);
	if (matches.length > 1) throw new Error(`ambiguous Herdr tab creation for ${label}`);
	if (matches.length === 1 && !(await closeTabOrConfirmAbsence(host, matches[0]!.tabId))) return matches[0]!.tabId;
	return undefined;
}

function runtimeDependencies(): string[] {
	const paths = new Set<string>([process.execPath, "/usr/bin/env"]);
	for (const executable of [process.execPath, "/usr/bin/env"]) {
		if (!existsSync(executable)) continue;
		try {
			const output = execFileSync("ldd", [executable], { encoding: "utf8" });
			for (const match of output.matchAll(/(?:=>\s*)?(\/[^\s(]+)/g)) if (existsSync(match[1]!)) paths.add(match[1]!);
		} catch {
			// Non-Linux hosts are rejected by preflight; Linux must supply paths
			// explicitly when ldd cannot establish them.
			if (process.platform === "linux")
				throw new Error(`unable to establish runtime dependencies for ${executable}`);
		}
	}
	for (const certificate of ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"])
		if (existsSync(certificate)) paths.add(certificate);
	return [...paths];
}

async function cleanupLaunchResources(
	options: HerdrAttemptOptions,
	host: HerdrAttemptHost,
	unit: string,
	tabId?: string,
): Promise<void> {
	options.database.createRuntimeCleanupIntents({
		attemptId: options.attemptId,
		unit,
		...(tabId ? { tabId } : {}),
		reason: "attempt launch authorization was invalidated",
	});
	if (tabId) {
		if (await closeTabOrConfirmAbsence(host, tabId)) {
			options.database.markRuntimeCleanupIntent("tab", tabId);
		} else {
			// The durable intent remains pending for controller recovery.
		}
	}
	if (host.stopSystemdUnit) {
		try {
			await host.stopSystemdUnit(unit);
			options.database.markRuntimeCleanupIntent("unit", unit);
		} catch {
			// The durable intent remains pending for controller recovery.
		}
	}
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
	const tabLabel = `background ${options.caseId} ${options.role} ${options.attemptId}`;
	const tabIntentPath = join(options.attemptDirectory, "herdr-tab-create-intent.json");
	mkdirSync(options.attemptDirectory, { recursive: true, mode: 0o700 });
	writeFileSync(tabIntentPath, `${JSON.stringify({ version: 1, attemptId: options.attemptId, label: tabLabel })}\n`, {
		mode: 0o600,
	});
	options.database.createArtifact({
		caseId: options.caseId,
		attemptId: options.attemptId,
		kind: "herdr-tab-create-intent",
		path: tabIntentPath,
		metadata: { version: 1, label: tabLabel },
	});
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
			inaccessiblePaths: [...new Set([...(options.inaccessiblePaths ?? []), ...runtime.profile.authFiles])],
			readOnlyPaths: [options.rolePromptPath, contextArtifact.path, runtime.agentDir],
			runtimePaths: [...runtimeDependencies(), ...(options.preflight?.paths ?? [])],
			writableGit: options.role === "worker",
			writableWorktree: options.role === "worker",
			exposePrimaryCheckout: options.role === "verifier",
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
			options.rolePromptPath,
		],
		credentialFiles: [...runtime.credentialFiles, ...(options.preflight?.credentialFiles ?? [])],
	});
	const host = dependencies.herdr ?? (defaultHerdr as unknown as HerdrAttemptHost);
	if (
		!options.database.attemptMayPublish(
			options.attemptId,
			options.database.get<{ stop_epoch: number }>("SELECT stop_epoch FROM attempts WHERE id = ?", options.attemptId)
				?.stop_epoch ?? -1,
		)
	) {
		await cleanupLaunchResources(options, host, unit);
		throw new Error("attempt launch authorization was invalidated before tab creation");
	}
	let tab: HerdrTab | undefined;
	try {
		tab = await host.createTab(tabLabel, undefined, options.worktreeDirectory);
	} catch (error) {
		try {
			const pendingTabId = await reconcileAmbiguousTabCreation(host, tabLabel);
			await cleanupLaunchResources(options, host, unit, pendingTabId);
		} catch (reconcileError) {
			await cleanupLaunchResources(options, host, unit);
			throw new Error(
				`Herdr tab creation is ambiguous: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`,
				{ cause: error },
			);
		}
		throw error;
	}
	if (!tab?.tabId) {
		try {
			const pendingTabId = await reconcileAmbiguousTabCreation(host, tabLabel);
			await cleanupLaunchResources(options, host, unit, pendingTabId);
		} catch (error) {
			await cleanupLaunchResources(options, host, unit);
			throw error;
		}
		throw new Error("Herdr did not return a tab");
	}
	options.database.run(
		"UPDATE attempts SET systemd_unit = ?, tab_id = ?, worktree = ? WHERE id = ?",
		unit,
		tab.tabId,
		options.worktreeDirectory,
		options.attemptId,
	);
	if (!tab.rootPaneId) {
		await cleanupLaunchResources(options, host, unit, tab.tabId);
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
		await cleanupLaunchResources(options, host, unit, tab.tabId);
		throw new Error(`Herdr pane is not ready: ${ready.error ?? "unknown error"}`);
	}
	if (
		!options.database.attemptMayPublish(
			options.attemptId,
			options.database.get<{ stop_epoch: number }>("SELECT stop_epoch FROM attempts WHERE id = ?", options.attemptId)
				?.stop_epoch ?? -1,
		)
	) {
		await cleanupLaunchResources(options, host, unit, tab.tabId);
		throw new Error("attempt launch authorization was invalidated before systemd launch");
	}
	const launched = await host.runCommand(tab.rootPaneId, command);
	if (!launched.ok) {
		await cleanupLaunchResources(options, host, unit, tab.tabId);
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
