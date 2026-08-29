/**
 * Sandbox-side tool allowlist and the gate that enforces it.
 *
 * A subagent's `tools:` frontmatter cannot be enforced with pi's `--tools`
 * filter any more: the child must keep `spindle_exec` (its only tool path in
 * full code mode), and keeping it would re-expose every core tool through
 * `pi.*`. The parent therefore forwards the declared list via the
 * `--${ALLOWED_TOOLS_FLAG}` CLI flag (see `agents/pi-args.ts`) and the child's
 * Spindle enforces it here, by removing the disallowed tools from the schema
 * the sandbox is type-checked against and rejecting them at the provider
 * boundary.
 *
 * `SpindleToolGate` is the one module that owns the allow decision: the two
 * providers (`pi`, `extensions`), the execution service, and the guest schema
 * shaping all consult a single gate rather than reimplementing the check. The
 * flag is *registered* by `agents/child-extension.ts` (loaded via `--extension`
 * only when the parent restricts tools). pi rejects the same flag name
 * registered by two extensions, so Spindle cannot also register it and
 * `pi.getFlag` — which only resolves flags the *reading* extension registered —
 * is unavailable here. Spindle reads the raw argv instead.
 *
 * Scope: the gate covers the `pi.*` and `extensions.*` namespaces, both of
 * which name concrete tools. `mcp.*`, `agents.*` and `workflow.*` are not
 * tools in that sense and stay available.
 */

/**
 * Transport tools: `spindle_exec` is the child's only tool path in full code
 * mode, so it is kept in the child's `--tools` regardless of the allowlist. It
 * is never callable from inside the sandbox, so declaring it in an allowlist is
 * meaningless; drop it when parsing and always allow it when checking.
 */
const TRANSPORT_TOOL_NAMES: ReadonlySet<string> = new Set(["spindle_exec"]);

/** Undefined means unrestricted; an empty set means nothing is callable. */
export type SpindleToolAllowlist = ReadonlySet<string>;

/**
 * Parse the flag value. Absent or blank yields `undefined` (unrestricted),
 * which is the normal case for a top-level session.
 */
export const parseToolAllowlist = (raw: unknown): SpindleToolAllowlist | undefined => {
	if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
	return new Set(
		raw
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name.length > 0 && !TRANSPORT_TOOL_NAMES.has(name)),
	);
};

/**
 * Read the allowlist straight off the process arguments, accepting both
 * `--flag value` and `--flag=value`. The last occurrence wins, matching how a
 * CLI parser would treat a repeated flag.
 */
export const readToolAllowlistArgument = (flag: string, argv: readonly string[] = process.argv): string | undefined => {
	const long = `--${flag}`;
	const assigned = `${long}=`;
	let value: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === long) {
			const next = argv[index + 1];
			if (next !== undefined && !next.startsWith("--")) value = next;
			continue;
		}
		if (argument.startsWith(assigned)) value = argument.slice(assigned.length);
	}
	return value;
};

/**
 * The tool gate: the single owner of "may this tool be called". An unrestricted
 * gate (built from an absent allowlist) permits everything and never throws; a
 * restricted gate permits only its members plus the always-allowed transport
 * tool. Callers pass their own namespace to `assert` so the rejection names the
 * sandbox call (`pi.bash`, `extensions.web_search`).
 */
export class SpindleToolGate {
	readonly #allowlist: SpindleToolAllowlist | undefined;

	private constructor(allowlist: SpindleToolAllowlist | undefined) {
		this.#allowlist = allowlist;
	}

	/** Build from an explicit allowlist; `undefined` yields an unrestricted gate. */
	static of(allowlist: SpindleToolAllowlist | undefined): SpindleToolGate {
		return new SpindleToolGate(allowlist);
	}

	/** Build from the process arguments: read the flag, parse it, wrap it. */
	static fromArgv(flag: string, argv?: readonly string[]): SpindleToolGate {
		return new SpindleToolGate(parseToolAllowlist(readToolAllowlistArgument(flag, argv)));
	}

	/** True when a subagent's `tools:` list narrowed what may be called. */
	get restricted(): boolean {
		return this.#allowlist !== undefined;
	}

	/** Whether `name` may be called. Unrestricted gates and the transport tool always pass. */
	allows(name: string): boolean {
		return this.#allowlist === undefined || TRANSPORT_TOOL_NAMES.has(name) || this.#allowlist.has(name);
	}

	/**
	 * Throw when `name` is disallowed. `namespace` is the sandbox namespace the
	 * caller belongs to (`pi` / `extensions`), so the message names the call as
	 * the model wrote it. A no-op on an unrestricted gate.
	 */
	assert(namespace: string, name: string): void {
		if (this.#allowlist === undefined || this.allows(name)) return;
		throw new Error(
			`Tool ${namespace}.${name} is not in this agent's tool allowlist (allowed: ${
				[...this.#allowlist].sort().join(", ") || "none"
			})`,
		);
	}
}
