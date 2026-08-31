/**
 * Sandbox policy for Spindle's pi core tools.
 *
 * The threat model is accidents, not adversaries: an unattended agent must not
 * be able to `rm -rf ~` at 3am. So this is a guardrail with two enforcement
 * points, both driven by the same policy:
 *
 *  - `bash` is wrapped by an OS-level sandbox (Seatbelt on macOS, bubblewrap on
 *    Linux) via `@anthropic-ai/sandbox-runtime`. See `manager.ts`.
 *  - `write` and `edit` are checked against the write allowlist directly, since
 *    they take absolute paths and never go through a shell.
 *
 * Read tools (`read`, `grep`, `find`, `ls`) are deliberately NOT gated here.
 * Reading is not the destructive path, and `denyRead` still applies to anything
 * running under `bash`, which is where an exfiltration attempt would live.
 *
 * The mode names mirror Codex CLI's (`read-only`, `workspace-write`,
 * `danger-full-access`) because that vocabulary is already familiar and maps
 * cleanly onto "the run's working copy is writable, the rest of the disk is
 * not".
 *
 * This module is pure: every environment input is injected, so the resolution
 * rules are testable without touching a real home directory.
 */

import { isAbsolute, join, relative } from "node:path";

export const SANDBOX_MODES = ["off", "read-only", "workspace-write", "full"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export interface SandboxNetworkPolicy {
	/** Domain patterns allowed through the sandbox proxy. `*` means unrestricted. */
	allowedDomains: string[];
	deniedDomains: string[];
}

export interface SandboxPolicy {
	mode: SandboxMode;
	/** Absolute directories writes are permitted under. */
	allowWrite: string[];
	/** Glob patterns denied even inside `allowWrite` (matched on basename, or on the full path when the pattern contains a slash). */
	denyWrite: string[];
	/** Absolute directories reads are denied under (enforced by the OS sandbox on `bash`). */
	denyRead: string[];
	network: SandboxNetworkPolicy;
}

export interface SandboxPolicyInput {
	mode?: SandboxMode;
	/** Extra roots to make writable. `~` is expanded; relative paths resolve against cwd. */
	allowWrite?: string[];
	denyWrite?: string[];
	denyRead?: string[];
	network?: Partial<SandboxNetworkPolicy>;
}

export interface PolicyEnvironment {
	/** The run's working directory: the writable root in `workspace-write`. */
	cwd: string;
	home: string;
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	/** Value of `os.tmpdir()`. */
	tmp: string;
}

/**
 * Credential directories denied to `bash`. `~/.aws` is deliberately absent:
 * SOPS/KMS decryption in real test suites needs it, and a run that cannot read
 * it fails in a way that looks like a broken sandbox rather than a policy.
 */
export const DEFAULT_DENY_READ = ["~/.ssh", "~/.gnupg"];

/** Secrets that stay unwritable even inside the workspace. */
export const DEFAULT_DENY_WRITE = [".env", ".env.*", "*.pem", "*.key", "*.p12", "id_rsa", "id_ed25519"];

export const DEFAULT_SANDBOX_MODE: SandboxMode = "workspace-write";

/**
 * The pattern this module spells "any host". It is spindle's own vocabulary:
 * `srt` has no way to express it, so it never reaches the runtime (see
 * `toSandboxRuntimeConfig`).
 */
export const UNRESTRICTED_DOMAIN = "*";

/** Unrestricted egress: the filesystem is what this guardrail is about. */
const DEFAULT_NETWORK: SandboxNetworkPolicy = { allowedDomains: [UNRESTRICTED_DOMAIN], deniedDomains: [] };

/** True when the policy asks for egress to any host. */
export function hasUnrestrictedEgress(policy: SandboxPolicy): boolean {
	return policy.network.allowedDomains.includes(UNRESTRICTED_DOMAIN);
}

export function isSandboxMode(value: unknown): value is SandboxMode {
	return typeof value === "string" && (SANDBOX_MODES as readonly string[]).includes(value);
}

/**
 * How much a mode restricts, for comparing two of them. `off` and `full` both
 * enforce nothing, so they rank equal at the bottom; `read-only` is the tightest.
 */
export function modeRestrictiveness(mode: SandboxMode): number {
	if (mode === "read-only") return 2;
	if (mode === "workspace-write") return 1;
	return 0;
}

/** The tighter of two modes. Ties keep `a`. */
export function tighterMode(a: SandboxMode, b: SandboxMode): SandboxMode {
	return modeRestrictiveness(b) > modeRestrictiveness(a) ? b : a;
}

/** True when the policy actually restricts anything. */
export function isEnforcing(policy: SandboxPolicy): boolean {
	return policy.mode === "read-only" || policy.mode === "workspace-write";
}

/** Expand a leading `~`, then resolve relative paths against `base`. */
export function expandPath(path: string, home: string, base: string): string {
	const trimmed = path.trim();
	if (!trimmed) return "";
	const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed;
	return isAbsolute(expanded) ? expanded : join(base, expanded);
}

/** True when `candidate` is `root` or lives under it. */
export function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const globToRegExp = (pattern: string): RegExp => {
	let source = "";
	for (const char of pattern) {
		if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
};

/** Match a deny pattern: full path when it contains a slash, else basename. */
export function matchesPattern(pattern: string, absolutePath: string): boolean {
	const target = pattern.includes("/") ? absolutePath : (absolutePath.split(/[\\/]/).pop() ?? absolutePath);
	return globToRegExp(pattern).test(target);
}

/**
 * Scratch and cache directories that must stay writable or nothing builds:
 * temp dirs, the platform cache home, and the Go/npm/Cargo caches. A run whose
 * only writable path is the repo spends the night failing on cache writes.
 */
export function toolCacheRoots(environment: PolicyEnvironment): string[] {
	const { env, home, platform, tmp } = environment;
	const platformCacheHome = platform === "darwin" ? join(home, "Library", "Caches") : join(home, ".cache");
	const goPath = env.GOPATH || join(home, "go");
	const candidates = [
		tmp,
		"/tmp",
		"/private/tmp",
		"/var/tmp",
		// Both, not either: Go and friends resolve the platform cache dir through
		// the OS API and ignore XDG_CACHE_HOME, so a machine that sets XDG would
		// otherwise lose its build cache.
		platformCacheHome,
		env.XDG_CACHE_HOME,
		env.GOCACHE,
		env.GOMODCACHE || join(goPath, "pkg", "mod"),
		env.npm_config_cache,
		env.CARGO_HOME,
		// mise writes tool installs under its data dir and trust/tracked-config
		// records under its state dir. A night task that installs a toolchain, or
		// trusts a config it just generated, needs both. This does mean a sandboxed
		// agent can record trust for a config, which is within the threat model:
		// the point is that it cannot delete the home directory.
		env.MISE_DATA_DIR || join(home, ".local", "share", "mise"),
		env.MISE_STATE_DIR || join(home, ".local", "state", "mise"),
		env.MISE_CACHE_DIR,
	];
	return dedupe(candidates.filter((value): value is string => !!value && isAbsolute(value)));
}

const dedupe = (values: string[]): string[] => [...new Set(values)];

/**
 * Resolve a policy from configuration plus environment.
 *
 * `workspace-write` grants the run directory and the tool caches. `read-only`
 * grants only the temp dirs, since a compiler that cannot write a temp file is
 * not a sandbox but a brick. `off` and `full` enforce nothing.
 */
export function resolveSandboxPolicy(input: SandboxPolicyInput, environment: PolicyEnvironment): SandboxPolicy {
	const mode = input.mode ?? DEFAULT_SANDBOX_MODE;
	const expand = (path: string) => expandPath(path, environment.home, environment.cwd);
	const extra = (input.allowWrite ?? []).map(expand).filter(Boolean);
	const caches = toolCacheRoots(environment);

	let allowWrite: string[];
	if (mode === "workspace-write") allowWrite = dedupe([environment.cwd, ...extra, ...caches]);
	else if (mode === "read-only") allowWrite = dedupe([...extra, environment.tmp, "/tmp"]);
	else allowWrite = [];

	return {
		mode,
		allowWrite,
		denyWrite: dedupe(input.denyWrite ?? DEFAULT_DENY_WRITE),
		denyRead: dedupe((input.denyRead ?? DEFAULT_DENY_READ).map(expand).filter(Boolean)),
		network: {
			allowedDomains: input.network?.allowedDomains ?? DEFAULT_NETWORK.allowedDomains,
			deniedDomains: input.network?.deniedDomains ?? DEFAULT_NETWORK.deniedDomains,
		},
	};
}

/** Build a policy from the ambient process environment. */
export function policyEnvironment(cwd: string, overrides: Partial<PolicyEnvironment> = {}): PolicyEnvironment {
	return {
		cwd,
		home: overrides.home ?? process.env.HOME ?? "",
		platform: overrides.platform ?? process.platform,
		env: overrides.env ?? process.env,
		tmp: overrides.tmp ?? "/tmp",
	};
}

/** Decide whether a write to `absolutePath` is permitted. */
export function isWriteAllowed(policy: SandboxPolicy, absolutePath: string): boolean {
	if (!isEnforcing(policy)) return true;
	if (policy.denyWrite.some((pattern) => matchesPattern(pattern, absolutePath))) return false;
	return policy.allowWrite.some((root) => isInside(root, absolutePath));
}

/** Throw a caller-facing error when a write is outside the policy. */
export function assertWriteAllowed(policy: SandboxPolicy, absolutePath: string): void {
	if (isWriteAllowed(policy, absolutePath)) return;
	const roots = policy.allowWrite.length ? policy.allowWrite.join(", ") : "(none)";
	throw new Error(`sandbox: write to ${absolutePath} denied by mode '${policy.mode}'. Writable roots: ${roots}`);
}

/**
 * Whether a read of `absolutePath` is denied. The read tools (`read`, `grep`,
 * `find`, `ls`) check this as a plain path guard, mirroring the denyRead roots
 * the OS sandbox already enforces on `bash`. Without it, a sandboxed program
 * could still pull a credential through `pi.read` and send it out through any
 * channel `bash` is allowed to reach.
 */
export function isReadDenied(policy: SandboxPolicy, absolutePath: string): boolean {
	if (!isEnforcing(policy)) return false;
	return policy.denyRead.some((root) => isInside(root, absolutePath));
}

/** Throw a caller-facing error when a read is under a denied root. */
export function assertReadAllowed(policy: SandboxPolicy, absolutePath: string): void {
	if (!isReadDenied(policy, absolutePath)) return;
	throw new Error(
		`sandbox: read of ${absolutePath} denied by mode '${policy.mode}'. Denied read roots: ${policy.denyRead.join(", ")}`,
	);
}

/**
 * The config object `@anthropic-ai/sandbox-runtime` expects.
 *
 * `*` is dropped from `allowedDomains`: `srt`'s matcher only understands an
 * exact host or `*.example.com`, so a bare `*` matches nothing and handing it
 * over turns "unrestricted" into "every CONNECT refused with a 403". The
 * allow-any intent is carried by the permission hook instead, see
 * `sandboxAskCallback` in `manager.ts`.
 */
export function toSandboxRuntimeConfig(policy: SandboxPolicy): {
	network: SandboxNetworkPolicy;
	filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] };
} {
	return {
		network: {
			...policy.network,
			allowedDomains: policy.network.allowedDomains.filter((domain) => domain !== UNRESTRICTED_DOMAIN),
		},
		filesystem: {
			allowWrite: policy.allowWrite,
			denyWrite: policy.denyWrite,
			denyRead: policy.denyRead,
		},
	};
}

/** One-line summary for status output. */
export function describeSandbox(policy: SandboxPolicy): string {
	if (!isEnforcing(policy)) return `sandbox ${policy.mode} (no enforcement)`;
	return `sandbox ${policy.mode}: ${policy.allowWrite.length} writable root(s), ${policy.denyRead.length} denied read path(s)`;
}
