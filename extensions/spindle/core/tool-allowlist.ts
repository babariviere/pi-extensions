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
 * Scope: the allowlist gates the `pi.*` and `extensions.*` namespaces, both of
 * which name concrete tools. `mcp.*`, `agents.*` and `workflow.*` are not
 * tools in that sense and stay available.
 */

/**
 * Transport tools: present so the child can run and answer at all, never
 * callable from inside the sandbox, so they are meaningless as allowlist
 * entries and are dropped when parsing.
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

export const isToolAllowed = (
  allowlist: SpindleToolAllowlist | undefined,
  name: string,
): boolean => allowlist === undefined || allowlist.has(name);

export const toolRestrictionError = (
  name: string,
  allowlist: SpindleToolAllowlist,
): Error =>
  new Error(
    `Tool ${name} is not in this agent's tool allowlist (allowed: ${
      [...allowlist].sort().join(", ") || "none"
    })`,
  );
