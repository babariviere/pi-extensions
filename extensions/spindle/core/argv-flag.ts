/**
 * Reading a Spindle flag straight off `process.argv`.
 *
 * Flags the parent sets on a subagent's `pi` process (the sandbox mode, and
 * historically the tool allowlist) cannot be read with `pi.getFlag`: that only
 * resolves flags the *reading* extension registered, and pi rejects the same
 * flag name registered twice, so the child-side extension registers them (to
 * keep startup from failing on an unknown option) while Spindle reads the raw
 * argv here.
 *
 * Pure, so the accepted spellings are testable without a process.
 */

/**
 * Read `--flag value` or `--flag=value` from `argv`. The last occurrence wins,
 * matching how a CLI parser would treat a repeated flag. A bare `--flag`
 * followed by another flag (or nothing) yields undefined rather than swallowing
 * the next flag as its value.
 */
export const readFlagArgument = (flag: string, argv: readonly string[] = process.argv): string | undefined => {
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
