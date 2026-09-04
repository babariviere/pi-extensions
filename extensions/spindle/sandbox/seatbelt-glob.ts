/**
 * Glob -> Seatbelt regex translation.
 *
 * Mirrors `policy.ts`'s `globToRegExp` exactly, character for character: only
 * `*` (any run of non-slash characters) and `?` (a single non-slash
 * character) are glob metacharacters; everything else -- including `{`, `}`,
 * `[`, `]`, `\\`, and `**` (which is just two `*` in a row, with no special
 * "cross directories" meaning) -- is a literal character, escaped for the
 * target regex dialect. That grammar, not a richer one, is what
 * `policy.ts`'s `matchesPattern` (and therefore `write`/`edit`'s path guards)
 * actually implements and what the config's documented grammar is. This used
 * to be a faithful port of Codex's richer `seatbelt_regex_for_glob` (bracket
 * classes, `{a,b}` alternation, and a `**` cross-component wildcard), but
 * that let the kernel profile and the path guards deny two different sets of
 * paths for the same `denyWrite` pattern whenever it contained one of those
 * metacharacters. Keeping the two translators in agreement is the whole
 * point: see the cross-check test in seatbelt-glob.test.ts.
 *
 * A pattern with no glob metacharacter gets `(/.*)?` appended in `"subtree"`
 * mode (so a literal directory name also denies its descendants), and nothing
 * in `"exact"` mode. Both are `^`-anchored and `$`-terminated.
 *
 * `seatbeltRegexForDenyPattern` adapts this to *this* repo's own
 * `matchesPattern` semantics (`policy.ts`): a pattern containing `/` is
 * anchored against the absolute path (translated in `"exact"` mode, so no
 * descendant suffix is added even for a literal), and a pattern with no `/`
 * matches a basename anywhere (translated in `"subtree"` mode, and prefixed
 * with an "any prefix directory" group).
 */

export type GlobMatch = "exact" | "subtree";

/** Escape a literal character for embedding in a regex. Same character set as
 * `policy.ts`'s `globToRegExp`. */
export function escapeSeatbeltRegexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `"` -> `\\"`, the escaping needed before embedding a regex in `#"..."`. */
export function quoteSeatbeltRegex(regex: string): string {
	return regex.replaceAll('"', '\\"');
}

export function seatbeltRegexForGlob(pattern: string, match: GlobMatch): string | undefined {
	if (!pattern) return undefined;

	let source = "";
	let sawGlob = false;
	for (const char of pattern) {
		if (char === "*") {
			source += "[^/]*";
			sawGlob = true;
		} else if (char === "?") {
			source += "[^/]";
			sawGlob = true;
		} else {
			source += escapeSeatbeltRegexLiteral(char);
		}
	}
	if (!sawGlob && match === "subtree") source += "(/.*)?";
	return `^${source}$`;
}

/**
 * Adapt `seatbeltRegexForGlob` to this repo's `matchesPattern` semantics: full
 * path when the pattern has a slash, basename-anywhere otherwise.
 */
export function seatbeltRegexForDenyPattern(pattern: string): string | undefined {
	const hasSlash = pattern.includes("/");
	const regex = seatbeltRegexForGlob(pattern, hasSlash ? "exact" : "subtree");
	if (regex === undefined) return undefined;
	if (hasSlash) return regex;
	// Insert the basename-anywhere prefix right after the leading ^.
	return `^(.*/)?${regex.slice(1)}`;
}
