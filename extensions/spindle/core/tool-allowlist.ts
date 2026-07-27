/**
 * Sandbox-side tool allowlist.
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
 * The flag is *registered* by `agents/result-tool.ts` (loaded into every child
 * via `--extension`, so the child accepts the arg even if Spindle itself is not
 * loaded there). pi rejects the same flag name registered by two extensions, so
 * Spindle cannot also register it and `pi.getFlag` — which only resolves flags
 * the *reading* extension registered — is unavailable here. Spindle reads the
 * raw argv instead.
 *
 * Scope: the allowlist gates the `pi.*` and `extensions.*` namespaces, both of
 * which name concrete tools. `mcp.*`, `agents.*` and `workflow.*` are not
 * tools in that sense and stay available.
 */

/**
 * Transport tools: present so the child can run and answer at all. In full code
 * mode `submit_result` is captured like any other extension tool and is only
 * reachable as `extensions.submit_result`, so the allowlist must never filter
 * it out — a subagent that cannot submit has no channel back to the caller.
 * They are dropped when parsing (declaring them is meaningless) and always
 * allowed when checking.
 */
const TRANSPORT_TOOL_NAMES: ReadonlySet<string> = new Set(["spindle_exec", "submit_result"]);

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
export const readToolAllowlistArgument = (
  flag: string,
  argv: readonly string[] = process.argv,
): string | undefined => {
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

export const isToolAllowed = (
  allowlist: SpindleToolAllowlist | undefined,
  name: string,
): boolean =>
  allowlist === undefined || TRANSPORT_TOOL_NAMES.has(name) || allowlist.has(name);

export const toolRestrictionError = (
  name: string,
  allowlist: SpindleToolAllowlist,
): Error =>
  new Error(
    `Tool ${name} is not in this agent's tool allowlist (allowed: ${
      [...allowlist].sort().join(", ") || "none"
    })`,
  );
