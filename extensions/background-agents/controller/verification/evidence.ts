import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type { EvidenceActualResult, EvidenceCommand, EvidenceManifest, EvidencePhase } from "../../types.ts";

export const EVIDENCE_MANIFEST_VERSION = 1 as const;
export const MAX_OUTPUT_BYTES = 16 * 1024;
const SHA = /^[0-9a-f]{40}$/i;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Environment names that the controller may expose to a replayed command. */
export const SAFE_REPLAY_ENVIRONMENT_NAMES = [
	"CI",
	"FORCE_COLOR",
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"NO_COLOR",
	"PATH",
	"TEMP",
	"TERM",
	"TMP",
	"TMPDIR",
	"TZ",
] as const;
const SAFE_REPLAY_ENVIRONMENT = new Set<string>(SAFE_REPLAY_ENVIRONMENT_NAMES);
const CREDENTIAL_ENVIRONMENT_NAME =
	/(?:^|_)(?:ACCESS[_-]?KEY|API[_-]?KEY|AUTH(?:ORIZATION)?|CERT(?:IFICATE)?|COOKIE|CREDENTIALS?|PASSWORD|PASSWD|PRIVATE[_-]?KEY|SECRET|TOKEN)(?:_|$)/i;

export interface EvidenceCommandInput {
	executable: string;
	argv?: readonly string[];
	args?: readonly string[];
	cwd?: string;
	workingDirectory?: string;
	timeoutMs: number;
	environment?: readonly string[];
	toolVersions?: Record<string, string>;
	phase: EvidencePhase;
	purpose: "reproduction" | "acceptance";
	expectedExitCode?: number;
	expected?: { exitCode: number };
	actual?: EvidenceActualResult;
	artifactChecksums?: Record<string, string>;
}

export interface EvidenceManifestInput {
	baseSha: string;
	candidateSha: string;
	commands: readonly EvidenceCommandInput[];
	createdAt?: string | Date;
	toolVersions?: Record<string, string>;
	bugReproduction?: boolean;
	acceptanceSummary?: string;
}

export function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
	return sha256(await readFile(path));
}

export function boundedOutputHash(output: string | Uint8Array): { hash: string; bytes: number; truncated: boolean } {
	const bytes = typeof output === "string" ? Buffer.byteLength(output) : output.byteLength;
	return { hash: sha256(output), bytes, truncated: bytes > MAX_OUTPUT_BYTES };
}

function nonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty`);
	return value.trim();
}

function relativeCwd(value: string | undefined): string {
	const cwd = value?.trim() || ".";
	const normalized = normalize(cwd);
	if (isAbsolute(cwd) || normalized === ".." || normalized.startsWith("../")) {
		throw new Error("evidence command cwd must be repository-relative");
	}
	return normalized || ".";
}

function sha(value: unknown, field: string): string {
	const result = nonEmpty(value, field);
	if (!SHA.test(result)) throw new Error(`${field} must be a Git commit SHA, not a ref`);
	return result.toLowerCase();
}

function timeout(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 86_400_000)
		throw new Error("evidence command timeoutMs must be a positive value no greater than 86400000");
	return value as number;
}

function validateEnvironmentName(name: string): void {
	if (!ENVIRONMENT_NAME.test(name)) throw new Error(`invalid environment name: ${name}`);
	if (CREDENTIAL_ENVIRONMENT_NAME.test(name)) {
		throw new Error(`credential-like environment name is forbidden for evidence replay: ${name}`);
	}
	if (!SAFE_REPLAY_ENVIRONMENT.has(name)) {
		throw new Error(`environment name is not allowed for evidence replay: ${name}`);
	}
}

function command(input: EvidenceCommandInput): EvidenceCommand {
	const executable = nonEmpty(input.executable, "evidence executable");
	const argv = [...(input.argv ?? input.args ?? [])].map((arg, index) => nonEmpty(arg, `evidence argv[${index}]`));
	const environment = [...(input.environment ?? [])];
	for (const name of environment) validateEnvironmentName(name);
	const cwd = relativeCwd(input.cwd ?? input.workingDirectory);
	const expectedExitCode = input.expected?.exitCode ?? input.expectedExitCode ?? 0;
	if (!Number.isSafeInteger(expectedExitCode) || expectedExitCode < 0 || expectedExitCode > 255)
		throw new Error("expected exit code must be an integer between 0 and 255");
	return {
		executable,
		argv,
		cwd,
		timeoutMs: timeout(input.timeoutMs),
		environment,
		toolVersions: { ...(input.toolVersions ?? {}) },
		phase: input.phase,
		purpose: input.purpose,
		expected: { exitCode: expectedExitCode },
		...(input.actual ? { actual: input.actual } : {}),
		...(input.artifactChecksums ? { artifactChecksums: { ...input.artifactChecksums } } : {}),
	};
}

/** Build and validate the immutable worker-produced manifest. */
export function createEvidenceManifest(input: EvidenceManifestInput): EvidenceManifest {
	const commands = input.commands.map(command);
	if (commands.length === 0) throw new Error("an evidence manifest needs at least one command");
	const acceptance = commands.filter((item) => item.phase === "candidate" && item.purpose === "acceptance");
	if (acceptance.length === 0) {
		throw new Error("an evidence manifest must contain a candidate acceptance command");
	}
	if (acceptance.some((item) => item.expected.exitCode !== 0)) {
		throw new Error("candidate acceptance commands must expect exit code 0");
	}
	if (
		input.bugReproduction &&
		(!commands.some((item) => item.phase === "base" && item.purpose === "reproduction") ||
			!commands.some((item) => item.phase === "candidate" && item.purpose === "reproduction") ||
			commands.some(
				(item) => item.phase === "base" && item.purpose === "reproduction" && item.expected.exitCode === 0,
			) ||
			commands.some(
				(item) => item.phase === "candidate" && item.purpose === "reproduction" && item.expected.exitCode !== 0,
			))
	) {
		throw new Error("bug reproduction manifests need base-fails and candidate-passes commands");
	}
	const createdAt = input.createdAt === undefined ? new Date() : new Date(input.createdAt);
	if (Number.isNaN(createdAt.getTime())) throw new Error("createdAt must be a valid timestamp");
	return {
		version: EVIDENCE_MANIFEST_VERSION,
		baseSha: sha(input.baseSha, "baseSha"),
		candidateSha: sha(input.candidateSha, "candidateSha"),
		commands,
		createdAt: createdAt.toISOString(),
		toolVersions: { ...(input.toolVersions ?? {}) },
		bugReproduction: input.bugReproduction ?? false,
		...(input.acceptanceSummary ? { acceptanceSummary: input.acceptanceSummary } : {}),
	};
}

export function commandArgv(command: EvidenceCommand): string[] {
	return [...(command.argv ?? command.args ?? [])];
}

export function commandCwd(command: EvidenceCommand): string {
	return command.cwd ?? command.workingDirectory ?? ".";
}

export function commandToolVersions(manifest: EvidenceManifest, command: EvidenceCommand): Record<string, string> {
	return { ...(manifest.toolVersions ?? {}), ...(command.toolVersions ?? {}) };
}

export function withEvidenceSection(
	body: string,
	manifest: EvidenceManifest,
	reproduction = "Run the verifier reproduction operation",
): string {
	const lines = [
		"## Evidence",
		"",
		`Manifest version: ${manifest.version}`,
		`Base: \`${manifest.baseSha}\``,
		`Candidate: \`${manifest.candidateSha}\``,
		`Checks: ${manifest.commands.length} argv-only command(s)`,
		manifest.acceptanceSummary ? `Acceptance: ${manifest.acceptanceSummary}` : undefined,
		`Reproduction: ${reproduction}`,
	].filter((line): line is string => line !== undefined);
	return `${body.trimEnd()}\n\n${lines.join("\n")}\n`;
}

export function formatEvidenceMarkdown(manifest: EvidenceManifest, verdict?: string): string {
	return [
		"## Evidence and reproduction",
		"",
		`- Manifest: v${manifest.version}`,
		`- Base commit: \`${manifest.baseSha}\``,
		`- Candidate commit: \`${manifest.candidateSha}\``,
		`- Commands: ${manifest.commands.length} (executable plus argv, no shell)`,
		`- Verdict: ${verdict ?? "not yet verified"}`,
		"- Re-run with the controller `evidence.reproduce` operation.",
	].join("\n");
}

export function recordActualResult(
	commandValue: EvidenceCommand,
	result: {
		exitCode: number | null;
		timedOut?: boolean;
		output: string | Uint8Array;
		stdout?: string;
		stderr?: string;
		outputHash?: string;
		outputBytes?: number;
		outputTruncated?: boolean;
		stdoutHash?: string;
		stdoutBytes?: number;
		stdoutTruncated?: boolean;
		stderrHash?: string;
		stderrBytes?: number;
		stderrTruncated?: boolean;
		artifactChecksums?: Record<string, string>;
	},
): EvidenceActualResult {
	const output = boundedOutputHash(result.output);
	return {
		exitCode: result.exitCode,
		timedOut: result.timedOut ?? false,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		outputHash: result.outputHash ?? output.hash,
		outputBytes: result.outputBytes ?? output.bytes,
		outputTruncated: result.outputTruncated ?? output.truncated,
		stdoutHash: result.stdoutHash ?? sha256(""),
		stdoutBytes: result.stdoutBytes ?? 0,
		stdoutTruncated: result.stdoutTruncated ?? false,
		stderrHash: result.stderrHash ?? sha256(""),
		stderrBytes: result.stderrBytes ?? 0,
		stderrTruncated: result.stderrTruncated ?? false,
		artifactChecksums: { ...(result.artifactChecksums ?? {}) },
	};
}
