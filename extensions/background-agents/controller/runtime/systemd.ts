import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { BackgroundAgentsConfig } from "../../types.ts";

const execFileAsync = promisify(execFile);
const MIN_SYSTEMD_VERSION = 247;

export interface CommandResult {
	ok: boolean;
	stdout?: string;
	error?: string;
}

export interface CommandRunner {
	run(command: string, args: string[]): Promise<CommandResult>;
}

const defaultRunner: CommandRunner = {
	async run(command, args) {
		try {
			const result = await execFileAsync(command, args, { shell: false, maxBuffer: 1024 * 1024 });
			return { ok: true, stdout: result.stdout };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	},
};

export interface HostPreflightOptions {
	platform?: string;
	runner?: CommandRunner;
	paths?: string[];
	credentialFiles?: string[];
	socketPath?: string;
	cgroupControllersPath?: string;
}

export interface HostPreflightResult {
	ok: boolean;
	errors: string[];
	systemdVersion?: number;
}

function version(stdout: string | undefined): number | undefined {
	const match = /systemd\s+(\d+)/i.exec(stdout ?? "");
	return match ? Number(match[1]) : undefined;
}

/** Check every host dependency before creating a tool-capable attempt. */
export async function preflightLinuxHost(options: HostPreflightOptions = {}): Promise<HostPreflightResult> {
	if ((options.platform ?? process.platform) !== "linux")
		return { ok: false, errors: ["background attempts require a Linux systemd host"] };
	const runner = options.runner ?? defaultRunner;
	const errors: string[] = [];
	const systemd = await runner.run("systemd-run", ["--version"]);
	const systemdVersion = version(systemd.stdout);
	if (!systemd.ok || systemdVersion === undefined)
		errors.push(`systemd-run is unavailable${systemd.error ? `: ${systemd.error}` : ""}`);
	else if (systemdVersion < MIN_SYSTEMD_VERSION)
		errors.push(`systemd ${MIN_SYSTEMD_VERSION} or newer is required (found ${systemdVersion})`);
	const systemdFeatures = await runner.run("systemd-run", ["--user", "--pty", "--wait", "--collect", "--help"]);
	if (!systemdFeatures.ok)
		errors.push(
			`systemd-run required service features are unavailable${systemdFeatures.error ? `: ${systemdFeatures.error}` : ""}`,
		);
	for (const [command, args] of [
		["herdr", ["--version"]],
		["git", ["--version"]],
		["gh", ["--version"]],
	] as const) {
		const result = await runner.run(command, [...args]);
		if (!result.ok) errors.push(`${command} is unavailable${result.error ? `: ${result.error}` : ""}`);
	}
	const stack = await runner.run("gh", ["stack", "--help"]);
	if (!stack.ok) errors.push(`gh stack is unavailable${stack.error ? `: ${stack.error}` : ""}`);
	const controllersPath = options.cgroupControllersPath ?? "/sys/fs/cgroup/cgroup.controllers";
	if (!existsSync(controllersPath)) errors.push(`cgroup v2 controllers are unavailable: ${controllersPath}`);
	else {
		const controllers = readFileSync(controllersPath, "utf8").split(/\s+/);
		for (const required of ["memory", "cpu", "pids"])
			if (!controllers.includes(required)) errors.push(`cgroup controller is unavailable: ${required}`);
	}
	for (const path of [...(options.paths ?? []), ...(options.credentialFiles ?? [])])
		if (!existsSync(path)) errors.push(`required path does not exist: ${path}`);
	if (options.socketPath) {
		if (!existsSync(options.socketPath)) errors.push(`socket does not exist: ${options.socketPath}`);
		else if ((statSync(options.socketPath).mode & 0o077) !== 0)
			errors.push("socket must not be group- or world-accessible");
	}
	return { ok: errors.length === 0, errors, ...(systemdVersion !== undefined ? { systemdVersion } : {}) };
}

export async function assertLinuxHostPreflight(options: HostPreflightOptions = {}): Promise<void> {
	const result = await preflightLinuxHost(options);
	if (!result.ok) throw new Error(`background-agent host preflight failed: ${result.errors.join("; ")}`);
}

export interface SystemdLaunchOptions {
	unit: string;
	workingDirectory: string;
	attemptDirectory: string;
	worktreeDirectory: string;
	primaryCheckout: string;
	gitDirectory: string;
	profileDirectory: string;
	sessionDirectory: string;
	piArgs: string[];
	limits: BackgroundAgentsConfig["systemd"];
	command?: string;
}

function absolute(path: string, field: string): string {
	if (!isAbsolute(path) || path.includes("\0")) throw new Error(`${field} must be an absolute path`);
	return resolve(path);
}

function descendant(path: string, parent: string): boolean {
	const rel = relative(parent, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeUnit(unit: string): string {
	if (!/^[A-Za-z0-9_.@:-]+$/.test(unit)) throw new Error("unit contains unsafe characters");
	return unit;
}

/** Build argv for systemd-run. No shell, interpolation, or secret values are used. */
export function buildSystemdRunArgs(options: SystemdLaunchOptions): string[] {
	const attempt = absolute(options.attemptDirectory, "attemptDirectory");
	const worktree = absolute(options.worktreeDirectory, "worktreeDirectory");
	const primary = absolute(options.primaryCheckout, "primaryCheckout");
	const git = absolute(options.gitDirectory, "gitDirectory");
	const profile = absolute(options.profileDirectory, "profileDirectory");
	const session = absolute(options.sessionDirectory, "sessionDirectory");
	if (descendant(worktree, primary)) throw new Error("worktree must not be inside the primary checkout");
	for (const [path, field] of [
		[profile, "profileDirectory"],
		[session, "sessionDirectory"],
	] as const)
		if (!descendant(path, attempt)) throw new Error(`${field} must be inside attemptDirectory`);
	if (!descendant(git, primary) && git !== primary)
		throw new Error("gitDirectory must be the configured shared git path");
	if (options.workingDirectory !== worktree) throw new Error("workingDirectory must be the dedicated worktree");
	if (options.piArgs.some((arg) => arg.includes("\0"))) throw new Error("Pi arguments contain a NUL byte");
	const limits = options.limits;
	if (
		limits.maxRuntimeMs <= 0 ||
		limits.memoryLimitBytes <= 0 ||
		limits.cpuQuotaPercent <= 0 ||
		limits.processLimit <= 0
	)
		throw new Error("systemd limits must be positive");
	const args = [
		"--user",
		"--pty",
		"--wait",
		"--collect",
		`--unit=${safeUnit(options.unit)}`,
		`--working-directory=${worktree}`,
		`--property=RuntimeMaxSec=${Math.ceil(limits.maxRuntimeMs / 1000)}s`,
		`--property=MemoryMax=${limits.memoryLimitBytes}`,
		`--property=CPUQuota=${limits.cpuQuotaPercent}%`,
		`--property=TasksMax=${limits.processLimit}`,
		"--property=PrivateUsers=yes",
		"--property=ProtectSystem=strict",
		"--property=ProtectHome=read-only",
		"--property=NoNewPrivileges=yes",
		"--property=CapabilityBoundingSet=",
		"--property=AmbientCapabilities=",
		"--property=PrivateDevices=yes",
		"--property=PrivateTmp=yes",
		"--property=TemporaryFileSystem=/tmp:ro",
		"--property=TemporaryFileSystem=/var/tmp:ro",
		"--property=ProtectKernelTunables=yes",
		"--property=ProtectControlGroups=yes",
		"--property=RestrictSUIDSGID=yes",
		"--property=RestrictNamespaces=yes",
		"--property=RestrictRealtime=yes",
		"--property=ProtectProc=invisible",
		"--property=ProcSubset=pid",
		"--property=KillMode=control-group",
		"--property=OOMPolicy=kill",
		"--property=LockPersonality=yes",
		"--property=UMask=0077",
		`--property=ReadWritePaths=${attempt}`,
		`--property=ReadWritePaths=${worktree}`,
		`--property=ReadWritePaths=${git}`,
		`--property=ReadOnlyPaths=${primary}`,
		`--setenv=PI_CODING_AGENT_DIR=${profile}`,
		`--setenv=PI_CODING_AGENT_SESSION_DIR=${session}`,
		"--setenv=PI_BACKGROUND_AGENT_ATTEMPT=1",
		`--setenv=HOME=${profile}`,
		`--setenv=TMPDIR=${attempt}`,
		options.command ?? "pi",
		...options.piArgs,
	];
	return args;
}

export interface TransientServiceRunner {
	run(args: string[], signal?: AbortSignal): Promise<CommandResult>;
}

export async function runTransientService(
	options: SystemdLaunchOptions,
	runner: TransientServiceRunner,
	signal?: AbortSignal,
): Promise<CommandResult> {
	return runner.run(buildSystemdRunArgs(options), signal);
}

export const buildTransientServiceArgs = buildSystemdRunArgs;
