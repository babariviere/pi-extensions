import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	SAFE_REPLAY_ENVIRONMENT_NAMES,
	MAX_OUTPUT_BYTES,
	createEvidenceManifest,
	commandArgv,
	commandCwd,
	recordActualResult,
	sha256File,
} from "./evidence.ts";
import type { EvidenceCommand, EvidenceManifest, EvidencePhase } from "../../types.ts";

export interface ReplayProcessResult {
	code: number | null;
	stdout: string;
	stderr: string;
	outputHash?: string;
	outputBytes?: number;
	outputTruncated?: boolean;
	stdoutHash?: string;
	stdoutBytes?: number;
	stdoutTruncated?: boolean;
	stderrHash?: string;
	stderrBytes?: number;
	stderrTruncated?: boolean;
	timedOut?: boolean;
}

export interface ReplayProcessOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
}

export type ReplayProcessRunner = (
	executable: string,
	argv: string[],
	options: ReplayProcessOptions,
) => Promise<ReplayProcessResult>;

const SAFE_REPLAY_ENVIRONMENT = new Set<string>(SAFE_REPLAY_ENVIRONMENT_NAMES);
const DEFAULT_PATH =
	process.platform === "win32" ? "%SystemRoot%\\system32;%SystemRoot%" : "/usr/local/bin:/usr/bin:/bin";

/** Construct a child environment from explicit controller inputs, never from arbitrary process.env keys. */
export function buildReplayEnvironment(
	source: NodeJS.ProcessEnv = process.env,
	requested: readonly string[] = [],
): Record<string, string> {
	const environment: Record<string, string> = { PATH: source.PATH ?? DEFAULT_PATH };
	for (const name of requested) {
		if (!SAFE_REPLAY_ENVIRONMENT.has(name)) continue;
		const value = source[name];
		if (value !== undefined) environment[name] = value;
	}
	return environment;
}

function safeRunnerEnvironment(source: Record<string, string | undefined>): Record<string, string> {
	return buildReplayEnvironment(source, Object.keys(source));
}

interface OutputCapture {
	hash: ReturnType<typeof createHash>;
	bytes: number;
	retainedBytes: number;
	chunks: Buffer[];
}

function outputCapture(): OutputCapture {
	return { hash: createHash("sha256"), bytes: 0, retainedBytes: 0, chunks: [] };
}

function capture(captureValue: OutputCapture, chunk: Buffer): void {
	captureValue.hash.update(chunk);
	captureValue.bytes += chunk.byteLength;
	if (captureValue.retainedBytes < MAX_OUTPUT_BYTES) {
		const retained = chunk.subarray(0, MAX_OUTPUT_BYTES - captureValue.retainedBytes);
		captureValue.chunks.push(retained);
		captureValue.retainedBytes += retained.byteLength;
	}
}

function capturedValue(captureValue: OutputCapture): string {
	return Buffer.concat(captureValue.chunks).toString();
}

/** Terminate a command and its descendants. Detached process groups work on POSIX; taskkill handles Windows. */
export function terminateProcessTree(child: ReturnType<typeof spawn>): void {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
			windowsHide: true,
			stdio: "ignore",
		});
		killer.once("error", () => child.kill("SIGKILL"));
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

export const spawnReplayRunner: ReplayProcessRunner = (executable, argv, options) =>
	new Promise((resolveResult, reject) => {
		const child = spawn(executable, argv, {
			cwd: options.cwd,
			env: safeRunnerEnvironment(options.env ?? process.env),
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutCapture = outputCapture();
		const stderrCapture = outputCapture();
		const output = outputCapture();
		let timedOut = false;
		const timer = options.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					terminateProcessTree(child);
				}, options.timeoutMs)
			: undefined;
		child.stdout.on("data", (chunk: Buffer) => {
			capture(stdoutCapture, chunk);
			capture(output, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			capture(stderrCapture, chunk);
			capture(output, chunk);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (timer) clearTimeout(timer);
			resolveResult({
				code,
				stdout: capturedValue(stdoutCapture),
				stderr: capturedValue(stderrCapture),
				outputHash: output.hash.digest("hex"),
				outputBytes: output.bytes,
				outputTruncated: output.bytes > MAX_OUTPUT_BYTES,
				stdoutHash: stdoutCapture.hash.digest("hex"),
				stdoutBytes: stdoutCapture.bytes,
				stdoutTruncated: stdoutCapture.bytes > MAX_OUTPUT_BYTES,
				stderrHash: stderrCapture.hash.digest("hex"),
				stderrBytes: stderrCapture.bytes,
				stderrTruncated: stderrCapture.bytes > MAX_OUTPUT_BYTES,
				timedOut,
			});
		});
	});

export interface CommandReplay {
	command: EvidenceCommand;
	phase: EvidencePhase;
	worktree: string;
	passed: boolean;
	actual: ReturnType<typeof recordActualResult>;
	reason?: string;
}

export interface ReplayResult {
	passed: boolean;
	clean: boolean;
	ancestry: boolean;
	commands: CommandReplay[];
	rationale: string;
	uncertainties: string[];
}

export interface ReplayOptions {
	repository: string;
	manifest: EvidenceManifest;
	runner?: ReplayProcessRunner;
	environment?: NodeJS.ProcessEnv;
	attemptDirectory?: string;
	homeDirectory?: string;
}

function git(
	runner: ReplayProcessRunner,
	repository: string,
	argv: string[],
	environment: NodeJS.ProcessEnv,
): Promise<ReplayProcessResult> {
	return runner("git", ["-C", repository, ...argv], {
		cwd: repository,
		env: buildReplayEnvironment(environment),
	});
}

function inside(root: string, path: string): boolean {
	const pathRelative = relative(root, path);
	return !isAbsolute(pathRelative) && pathRelative !== ".." && !pathRelative.startsWith("../");
}

async function checkedGit(
	runner: ReplayProcessRunner,
	repository: string,
	argv: string[],
	environment: NodeJS.ProcessEnv,
): Promise<string> {
	const result = await git(runner, repository, argv, environment);
	if (result.code !== 0) throw new Error(result.stderr || result.stdout || `git ${argv.join(" ")} failed`);
	return result.stdout.trim();
}

async function replayCommand(
	command: EvidenceCommand,
	phase: EvidencePhase,
	worktree: string,
	runner: ReplayProcessRunner,
	environment: NodeJS.ProcessEnv,
): Promise<CommandReplay> {
	const cwd = resolve(worktree, commandCwd(command));
	if (!inside(worktree, cwd))
		throw new Error(`evidence command cwd escapes verifier worktree: ${commandCwd(command)}`);
	const env = buildReplayEnvironment(environment, command.environment ?? []);
	const result = await runner(command.executable, commandArgv(command), { cwd, env, timeoutMs: command.timeoutMs });
	const artifactChecksums: Record<string, string> = {};
	for (const [path, expected] of Object.entries(command.artifactChecksums ?? {})) {
		const artifact = resolve(worktree, path);
		if (!inside(worktree, artifact)) throw new Error(`artifact path escapes verifier worktree: ${path}`);
		try {
			artifactChecksums[path] = await sha256File(artifact);
		} catch {
			artifactChecksums[path] = "missing";
		}
		if (artifactChecksums[path] !== expected) {
			return {
				command,
				phase,
				worktree,
				passed: false,
				actual: recordActualResult(command, {
					exitCode: result.code,
					timedOut: result.timedOut,
					output: `${result.stdout}${result.stderr}`,
					stdout: result.stdout,
					stderr: result.stderr,
					outputHash: result.outputHash,
					outputBytes: result.outputBytes,
					outputTruncated: result.outputTruncated,
					stdoutHash: result.stdoutHash,
					stdoutBytes: result.stdoutBytes,
					stdoutTruncated: result.stdoutTruncated,
					stderrHash: result.stderrHash,
					stderrBytes: result.stderrBytes,
					stderrTruncated: result.stderrTruncated,
					artifactChecksums,
				}),
				reason: `artifact checksum mismatch for ${path}`,
			};
		}
	}
	const actual = recordActualResult(command, {
		exitCode: result.code,
		timedOut: result.timedOut,
		output: `${result.stdout}${result.stderr}`,
		stdout: result.stdout,
		stderr: result.stderr,
		outputHash: result.outputHash,
		outputBytes: result.outputBytes,
		outputTruncated: result.outputTruncated,
		stdoutHash: result.stdoutHash,
		stdoutBytes: result.stdoutBytes,
		stdoutTruncated: result.stdoutTruncated,
		stderrHash: result.stderrHash,
		stderrBytes: result.stderrBytes,
		stderrTruncated: result.stderrTruncated,
		artifactChecksums,
	});
	const passed = !result.timedOut && result.code === command.expected.exitCode;
	return {
		command,
		phase,
		worktree,
		passed,
		actual,
		...(passed
			? {}
			: {
					reason: result.timedOut
						? "command timed out"
						: `expected exit ${command.expected.exitCode}, got ${result.code}`,
				}),
	};
}

/** Replay commands in throw-away detached worktrees. No shell is involved. */
export async function replayEvidence(options: ReplayOptions): Promise<ReplayResult> {
	const runner = options.runner ?? spawnReplayRunner;
	const manifest = createEvidenceManifest({ ...options.manifest, commands: options.manifest.commands });
	const environment = options.environment ?? process.env;
	const uncertainties: string[] = [];
	const status = await git(runner, options.repository, ["status", "--porcelain"], environment);
	const clean = status.code === 0 && status.stdout.trim() === "";
	if (!clean)
		return {
			passed: false,
			clean,
			ancestry: false,
			commands: [],
			rationale: "repository is not clean",
			uncertainties,
		};
	const baseResolved = await checkedGit(
		runner,
		options.repository,
		["rev-parse", `${manifest.baseSha}^{commit}`],
		environment,
	);
	const candidateResolved = await checkedGit(
		runner,
		options.repository,
		["rev-parse", `${manifest.candidateSha}^{commit}`],
		environment,
	);
	if (baseResolved.toLowerCase() !== manifest.baseSha.toLowerCase())
		throw new Error("base SHA did not resolve exactly");
	if (candidateResolved.toLowerCase() !== manifest.candidateSha.toLowerCase())
		throw new Error("candidate SHA did not resolve exactly");
	const ancestryResult = await git(
		runner,
		options.repository,
		["merge-base", "--is-ancestor", baseResolved, candidateResolved],
		environment,
	);
	const ancestry = ancestryResult.code === 0;
	if (!ancestry)
		return {
			passed: false,
			clean,
			ancestry,
			commands: [],
			rationale: "candidate is not descended from base",
			uncertainties,
		};
	const parent = await mkdtemp(
		join(options.attemptDirectory ? resolve(options.attemptDirectory) : tmpdir(), "background-verifier-"),
	);
	const home = options.homeDirectory ? resolve(options.homeDirectory) : join(parent, "home");
	await mkdir(home, { recursive: true, mode: 0o700 });
	const isolatedEnvironment = { ...environment, HOME: home, TMPDIR: parent };
	const commandResults: CommandReplay[] = [];
	try {
		for (const phase of ["base", "candidate"] as const) {
			const phaseCommands = manifest.commands.filter((item) => item.phase === phase);
			if (phaseCommands.length === 0) continue;
			const worktree = join(parent, phase);
			const sha = phase === "base" ? baseResolved : candidateResolved;
			const cloned = await runner(
				"git",
				["clone", "--no-local", "--no-hardlinks", "--no-checkout", options.repository, worktree],
				{ cwd: parent, env: buildReplayEnvironment(isolatedEnvironment) },
			);
			if (cloned.code !== 0)
				throw new Error(cloned.stderr || cloned.stdout || "unable to create isolated verifier clone");
			await checkedGit(runner, worktree, ["checkout", "--detach", sha], isolatedEnvironment);
			for (const command of phaseCommands)
				commandResults.push(await replayCommand(command, phase, worktree, runner, isolatedEnvironment));
		}
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
	const failed = commandResults.find((item) => !item.passed);
	return {
		passed: commandResults.length > 0 && !failed,
		clean,
		ancestry,
		commands: commandResults,
		rationale: failed?.reason ?? "all evidence commands passed",
		uncertainties,
	};
}

export const EVIDENCE_REPRODUCE_OPERATION = "evidence.reproduce" as const;
export interface EvidenceReproduceRequest {
	operation: typeof EVIDENCE_REPRODUCE_OPERATION;
	caseId: string;
	manifestId: string;
	prNumber?: number;
	reason?: string;
}

export interface EvidenceReproduceOperationResult {
	operation: typeof EVIDENCE_REPRODUCE_OPERATION;
	caseId: string;
	manifestId: string;
	jobId: string;
}

export interface EvidenceReproduceDependencies {
	database: {
		getEvidenceManifest(id: string): EvidenceManifest | undefined;
		getEvidenceManifestOwner(id: string): { caseId: string; baseSha: string; candidateSha: string } | undefined;
		createJob(input: {
			caseId: string;
			role: "verifier";
			manifestId: string;
			expectedBaseSha: string;
			expectedCandidateSha: string;
			priority?: number;
		}): string;
	};
}

/** Controller-facing contract. It only queues a verifier service and never runs evidence commands. */
export async function reproduceEvidenceOperation(
	request: EvidenceReproduceRequest,
	dependencies: EvidenceReproduceDependencies,
): Promise<EvidenceReproduceOperationResult> {
	if (request.operation !== EVIDENCE_REPRODUCE_OPERATION) throw new Error("unsupported evidence operation");
	const manifest = dependencies.database.getEvidenceManifest(request.manifestId);
	if (!manifest) throw new Error(`Unknown evidence manifest: ${request.manifestId}`);
	const owner = dependencies.database.getEvidenceManifestOwner(request.manifestId);
	if (!owner || owner.caseId !== request.caseId)
		throw new Error("evidence manifest does not belong to the selected case");
	const jobId = dependencies.database.createJob({
		caseId: request.caseId,
		role: "verifier",
		manifestId: request.manifestId,
		expectedBaseSha: owner.baseSha,
		expectedCandidateSha: owner.candidateSha,
		priority: 100,
	});
	return {
		operation: EVIDENCE_REPRODUCE_OPERATION,
		caseId: request.caseId,
		manifestId: request.manifestId,
		jobId,
	};
}
