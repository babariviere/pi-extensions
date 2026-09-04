/**
 * Assemble the Seatbelt (SBPL) profile for a resolved `SandboxPolicy`.
 *
 * Rule order matters: SBPL evaluates every rule in order and the *last*
 * matching rule wins, which is why every deny in this profile is appended
 * after every allow that could otherwise cover the same path. See the
 * section-by-section comments below, and the trap table in
 * `.pi/goal/plan.md` for why each one exists.
 *
 * Nothing here ever splices a path into the profile text: every root and
 * carve-out travels as a `-D KEY=VALUE` pair and a `(param "KEY")`
 * reference, because `sandbox-exec` hard-errors on an undefined param and
 * because a path containing a `"` would otherwise have to be escaped by hand.
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
	SEATBELT_NETWORK,
	SEATBELT_PREFERENCES,
	SEATBELT_PROCESS_PLATFORM_DEFAULTS,
	SEATBELT_READ_ONLY_PLATFORM_DEFAULTS,
	SEATBELT_BASE,
} from "./seatbelt/fragments.ts";
import { isInside, type SandboxPolicy } from "./policy.ts";
import { quoteSeatbeltRegex, seatbeltRegexForDenyPattern } from "./seatbelt-glob.ts";

export interface SeatbeltProfile {
	/** Full SBPL text, ready to write to a `.sb` file and pass to `sandbox-exec -f`. */
	profile: string;
	/** `-D KEY=VALUE` pairs, in the order they should be passed on the command line. */
	params: Array<[string, string]>;
	/** Roots that were canonicalized (a symlinked root) or dropped (unreadable). */
	warnings: string[];
}

/**
 * Assigns `-D` parameter names and de-duplicates by value: a path requested
 * under two different roles (say, a `denyRead` root that also falls inside a
 * writable root) gets exactly one `-D` entry and one key, reused everywhere
 * it is referenced. This is what keeps every `-D` in `params` actually
 * referenced, and keeps the same value from ever being handed two names.
 */
class ParamTable {
	#byValue = new Map<string, string>();
	#counters = new Map<string, number>();
	#entries: Array<[string, string]> = [];

	intern(prefix: string, value: string): string {
		const existing = this.#byValue.get(value);
		if (existing) return existing;
		const next = this.#counters.get(prefix) ?? 0;
		this.#counters.set(prefix, next + 1);
		const key = `${prefix}_${next}`;
		this.#byValue.set(value, key);
		this.#entries.push([key, value]);
		return key;
	}

	get params(): Array<[string, string]> {
		return this.#entries;
	}
}

/** Path segments of an absolute POSIX path, e.g. `/a/b` -> `["a", "b"]`. */
const segments = (path: string): string[] => path.split("/").filter(Boolean);

/** The absolute path of the top-level component, e.g. `/tmp/x/y` -> `/tmp`. */
const topLevelOf = (path: string): string => {
	const parts = segments(path);
	return parts.length > 0 ? `/${parts[0]}` : path;
};

/**
 * Canonicalize *only* the top-level path component when it is a symlink
 * (`/tmp` -> `/private/tmp`, `/var` -> `/private/var`, `/etc` -> `/private/etc`),
 * preserving the suffix untouched. Deeper components are deliberately not
 * followed here: a component below the top level can be mutated by an
 * already-running sandboxed process, so resolving it would turn a path check
 * into a new authority grant. Load-bearing because `/tmp` is in every
 * policy's `allowWrite` (`policy.ts`), so a rule written against the
 * unresolved alias would never match what the kernel reports.
 */
export function normalizeTopLevelAlias(path: string): string {
	const top = topLevelOf(path);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(top);
	} catch {
		return path;
	}
	if (!stat.isSymbolicLink()) return path;
	let resolvedTop: string;
	try {
		resolvedTop = realpathSync(top);
	} catch {
		return path;
	}
	return resolvedTop + path.slice(top.length);
}

/**
 * The deepest ancestor of `path` (including `path` itself) that is a symlink
 * and lies strictly below the top-level component, or undefined when there is
 * none. Mirrors Codex's `nested_symlink_component`: an ancestor only counts
 * when it has a grandparent, which excludes `/` and every top-level
 * component (`/tmp`, `/var`, ...) from consideration here; those are handled
 * by `normalizeTopLevelAlias` instead.
 */
export function nestedSymlinkComponent(path: string): string | undefined {
	const parts = segments(path);
	for (let depth = parts.length; depth >= 2; depth--) {
		const ancestor = `/${parts.slice(0, depth).join("/")}`;
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(ancestor);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) return ancestor;
	}
	return undefined;
}

/**
 * Canonicalize a policy root for the profile. Consciously deviates from
 * Codex here: Codex hard-errors on a symlinked root below the top level; this
 * canonicalizes the whole path with `realpathSync` instead, and records a
 * warning naming the root and its resolution. Two reasons: Seatbelt matches
 * on the *resolved* path of the accessed file, so a rule built from an
 * unresolved root would simply never match (this is required for the rule to
 * work at all, not just a threat-model concession); and the stated threat
 * model here is accidents, not adversaries, so rejecting would brick any
 * machine whose `$HOME` or a cache directory is a symlink.
 *
 * Returns undefined when the root cannot be `lstat`ed for any reason other
 * than `ENOENT` (a missing root is kept, since `sandbox-exec` accepts a
 * param pointing at a path that does not exist yet).
 */
export function canonicalizeRoot(root: string, warnings: string[]): string | undefined {
	const topNormalized = normalizeTopLevelAlias(root);
	const nested = nestedSymlinkComponent(topNormalized);
	if (nested) {
		try {
			const resolved = realpathSync(topNormalized);
			warnings.push(`sandbox: root '${root}' resolved through symlink '${nested}' to '${resolved}'`);
			return resolved;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warnings.push(`sandbox: root '${root}' could not be resolved (${message}); dropped from the profile`);
			return undefined;
		}
	}
	try {
		lstatSync(topNormalized);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code !== "ENOENT") {
			const message = error instanceof Error ? error.message : String(error);
			warnings.push(`sandbox: root '${root}' could not be inspected (${message}); dropped from the profile`);
			return undefined;
		}
	}
	return topNormalized;
}

/** Whether a canonicalized root should be matched with `literal` or `subpath`. */
function rootPathMatch(path: string): "literal" | "subpath" {
	try {
		return statSync(path).isDirectory() ? "subpath" : "literal";
	} catch {
		// Missing: kept as a subpath param so a directory created later still matches.
		return "subpath";
	}
}

/** The static directory prefix of a glob pattern, up to its first metacharacter. */
function staticDirPrefixOf(pattern: string): string | undefined {
	const metaIndex = pattern.search(/[*?[{\\]/);
	const prefix = metaIndex === -1 ? pattern : pattern.slice(0, metaIndex);
	const slash = prefix.lastIndexOf("/");
	return slash > 0 ? prefix.slice(0, slash) : undefined;
}

const rootFilter = (match: "literal" | "subpath", key: string): string =>
	match === "literal" ? `(literal (param "${key}"))` : `(subpath (param "${key}"))`;

export function buildSeatbeltProfile(policy: SandboxPolicy): SeatbeltProfile {
	const warnings: string[] = [];
	const table = new ParamTable();
	const sections: string[] = [];

	// 1. Codex's closed-by-default base.
	sections.push(SEATBELT_BASE.trim());

	// Canonicalize every denyRead root once; every later section reuses this
	// list. Unlike a writable root (below), a denyRead root that cannot be
	// canonicalized is never silently dropped: dropping it would remove it from
	// BOTH the read-allow carve-out below and the explicit deny lines in
	// section 7, exposing a configured protected path (e.g. `~/.ssh`) to
	// `bash` in full. So this fails closed: buildSeatbeltProfile throws,
	// initialize() rejects, and bash refuses to run rather than start with a
	// hole in it. `write`/`edit` still enforce denyRead independently through
	// the path guards in policy.ts (isReadDenied / assertReadAllowed), so this
	// failure mode only ever affected bash.
	const denyReadRoots: Array<{ original: string; canonical: string }> = [];
	for (const root of policy.denyRead) {
		const rootWarnings: string[] = [];
		const canonical = canonicalizeRoot(root, rootWarnings);
		if (canonical === undefined) {
			const detail = rootWarnings[rootWarnings.length - 1] ?? "unknown error";
			throw new Error(
				`sandbox: denyRead root '${root}' could not be canonicalized; refusing to start rather than risk ` +
					`exposing it. ${detail}`,
			);
		}
		warnings.push(...rootWarnings);
		denyReadRoots.push({ original: root, canonical });
	}

	// 2. Read allow: everything under "/", minus the denyRead carve-outs. Both
	// `literal` and `subpath` forms exclude each root, so first-time creation
	// of the protected path itself (not just its contents) is also excluded.
	const readRootKey = table.intern("READABLE_ROOT", "/");
	const readExcludeParts: string[] = [];
	for (const denyRoot of denyReadRoots) {
		const key = table.intern("READABLE_ROOT_0_EXCLUDED", denyRoot.canonical);
		readExcludeParts.push(`(require-not (literal (param "${key}")))`, `(require-not (subpath (param "${key}")))`);
	}
	sections.push(
		readExcludeParts.length
			? `(allow file-read* file-test-existence file-map-executable\n  (require-all (subpath (param "${readRootKey}")) ${readExcludeParts.join(" ")}))`
			: `(allow file-read* file-test-existence file-map-executable (subpath (param "${readRootKey}")))`,
	);

	// 3. Preferences: unrestricted apart from the same carve-outs, per its own header.
	sections.push(SEATBELT_PREFERENCES.trim());

	// 4. Write allow, only when there is something to grant. Roots are deduped
	// by canonical value: two allowWrite entries that resolve to the same path
	// (e.g. `/tmp` and `/private/tmp`, both present in `toolCacheRoots`) must
	// produce exactly one root filter and one root-anchor unlink deny, never a
	// byte-identical duplicate of each.
	const writableRoots: Array<{ original: string; canonical: string; match: "literal" | "subpath" }> = [];
	const seenWritableCanonical = new Set<string>();
	for (const root of policy.allowWrite) {
		const canonical = canonicalizeRoot(root, warnings);
		if (canonical === undefined) continue;
		if (seenWritableCanonical.has(canonical)) continue;
		seenWritableCanonical.add(canonical);
		writableRoots.push({ original: root, canonical, match: rootPathMatch(canonical) });
	}
	// Root-anchor unlink denies: the process must not be able to delete the
	// directory that *is* the authority boundary for a writable root. Collected
	// here but emitted in section 7, after every allow -- including the
	// vendored fragments -- since SBPL's last-matching-rule-wins semantics mean
	// a deny emitted here, before those fragments, would only be accidentally
	// safe (it holds only because none of them currently grants file-write*
	// over a writable root).
	const unlinkDenies: string[] = [];
	if (writableRoots.length > 0) {
		const rootFilters: string[] = [];
		for (const writable of writableRoots) {
			const key = table.intern("WRITABLE_ROOT", writable.canonical);
			const filter = rootFilter(writable.match, key);
			const nested: string[] = [];
			for (const denyRoot of denyReadRoots) {
				if (!isInside(writable.canonical, denyRoot.canonical)) continue;
				const excludedKey = table.intern("READABLE_ROOT_0_EXCLUDED", denyRoot.canonical);
				nested.push(
					`(require-not (literal (param "${excludedKey}")))`,
					`(require-not (subpath (param "${excludedKey}")))`,
				);
			}
			rootFilters.push(nested.length ? `(require-all ${filter} ${nested.join(" ")})` : filter);
			unlinkDenies.push(`(deny file-write-unlink (require-all (literal (param "${key}")) (vnode-type DIRECTORY)))`);
		}
		sections.push(`(allow file-write*\n${rootFilters.join("\n")})`);
	}

	// 5. Network: unconditionally unrestricted. `(allow network*)` covers bind,
	// inbound and outbound, so loopback listen+connect needs no extra flag; the
	// unqualified `(allow system-socket)` covers AF_UNIX in addition to the
	// vendored fragment's AF_SYSTEM protocol-2 rule, which is what
	// SSH_AUTH_SOCK, docker and unix-socket Postgres need.
	sections.push("(allow network*)\n(allow system-socket)");
	sections.push(SEATBELT_NETWORK.trim());

	// 6. Platform defaults: system read paths/dylibs, then our stripped process defaults.
	sections.push(SEATBELT_READ_ONLY_PLATFORM_DEFAULTS.trim());
	sections.push(SEATBELT_PROCESS_PLATFORM_DEFAULTS.trim());

	// 7. Deny section: the root-anchor unlink denies (see 4 above), then
	// denyWrite globs, then the denyRead carve-outs again, as literal denies
	// (defence in depth on top of the require-not carve-out above, so a future
	// extra allow rule cannot silently reopen them). Everything from here down
	// comes after every allow section above, including the vendored fragments.
	const denyLines: string[] = [...unlinkDenies];
	for (const pattern of policy.denyWrite) {
		const regex = seatbeltRegexForDenyPattern(pattern);
		if (regex === undefined) continue;
		denyLines.push(`(deny file-write* (regex #"${quoteSeatbeltRegex(regex)}"))`);
	}
	for (const denyRoot of denyReadRoots) {
		const key = table.intern("READABLE_ROOT_0_EXCLUDED", denyRoot.canonical);
		denyLines.push(
			`(deny file-read* (subpath (param "${key}")))`,
			`(deny file-read* (literal (param "${key}")))`,
			`(deny file-write* (subpath (param "${key}")))`,
			`(deny file-write* (literal (param "${key}")))`,
		);
	}
	if (denyLines.length) sections.push(denyLines.join("\n"));

	// 8. Rename-escape denies, last: renaming an allowed ancestor relocates its
	// protected descendants past their pathname carve-outs, so these must be
	// the final word on `file-write-unlink` for these directories.
	const protectedAncestors = new Set<string>();
	for (const writable of writableRoots) {
		const protectedPaths: string[] = [];
		for (const denyRoot of denyReadRoots) {
			if (isInside(writable.canonical, denyRoot.canonical)) protectedPaths.push(denyRoot.canonical);
		}
		for (const pattern of policy.denyWrite) {
			if (!pattern.includes("/")) continue;
			const staticDir = staticDirPrefixOf(pattern);
			if (staticDir !== undefined && isInside(writable.canonical, staticDir)) protectedPaths.push(staticDir);
		}
		for (const protectedPath of protectedPaths) {
			let current = dirname(protectedPath);
			// Walk up from the protected path's parent to (but not including) the
			// writable root itself: the root's own boundary is already covered by
			// the root-anchor unlink deny above (same param, same value), so
			// re-denying it here would only mint a duplicate rule under a second
			// name.
			for (;;) {
				if (current === writable.canonical || !isInside(writable.canonical, current)) break;
				protectedAncestors.add(current);
				const parent = dirname(current);
				if (parent === current) break;
				current = parent;
			}
		}
	}
	if (protectedAncestors.size > 0) {
		const ancestorDenies = [...protectedAncestors].map((ancestor) => {
			const key = table.intern("PROTECTED_ANCESTOR", ancestor);
			return `(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal (param "${key}"))))`;
		});
		sections.push(ancestorDenies.join("\n"));
	}

	const profile = sections.filter((section) => section.trim().length > 0).join("\n\n");
	return { profile, params: table.params, warnings };
}
