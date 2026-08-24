/**
 * secret-ref.ts — reversible secret references.
 *
 * A ref is what the model sees in place of a secret value:
 *
 *   <secret:github-token:9f2c4ab1>   minted ref, produced by the scrubber
 *   <secret:GITHUB_TOKEN>            authoring ref, written by the model
 *
 * Minted refs are content-addressed: the id is HMAC-SHA256(session key, value)
 * truncated. Consequences:
 *
 *   - the same value always gets the same ref, in any file, in any turn, so an
 *     `edit` whose oldText was captured three turns ago still matches;
 *   - two distinct values of the same kind get distinct refs without a counter,
 *     so read order never renumbers anything;
 *   - a literal `<secret:github-token:deadbeef>` sitting in a repo file does not
 *     resolve, and is escaped on the way out so it stays inert.
 *
 * The label (`github-token`) is cosmetic. Lookup is by id only, so it does not
 * matter whether the value came from fnox or from pattern detection.
 *
 * Security model is cooperative, not adversarial. Anything that can run bash can
 * exfiltrate anything the process can reach. Refs prevent accidents (a masked
 * value transcribed back into a config file), not a hostile model. The one
 * adversarial property they carry is per-tool scoping: hydration is opt-in per
 * tool, so a ref copied into a URL is inert.
 *
 * Consumed by: extensions/secrets/secret-policy.ts, extensions/secrets/index.ts
 */

import { createHmac, randomBytes } from "node:crypto";
import { refMatcher, type RefCodec, slugLabel } from "./secret-mask.ts";

/** Env var carrying the session key to child pi processes (subagents). */
export const REF_KEY_ENV = "PI_SECRETS_REF_KEY";

/**
 * Mask artifacts a model may transcribe back into a file: the `[NAME: value]`
 * marker this extension used to emit, or a bare `prefix` + stars whose prefix
 * belongs to a known credential format. Writing one is always data loss.
 *
 * Deliberately narrow. `[REDACTED:NAME]` (another extension's marker) is not
 * matched: this extension never emits it, so the model cannot have copied it
 * out of tool output, and matching it would block writing any prose that
 * mentions redaction, including this repository's own sources.
 */
const MASK_ARTIFACT_RE =
	/\[[A-Za-z][A-Za-z0-9_]{0,63}: ?[A-Za-z0-9_.\-/+]{2,64}\*{4}[A-Za-z0-9_.\-/+]{0,32}\]|(?:gh[pousr]_|github_pat_|sk-ant-|sk-proj-|sk-svcacct-|sk-admin-|xox[bpear][-.]|glpat-|gloas-|glptt-|glrt-|AKIA|ASIA|AIza|GOCSPX-|ya29\.|npm_|hf_|whsec_|sk_live_|sk_test_|pk_live_|pk_test_|SG\.)[A-Za-z0-9_.\-/+]{0,32}\*{4}/;

/**
 * True when `text` contains a mask artifact that must never reach disk.
 *
 * The substring gate matters: the regex runs on every write payload, and an
 * unbounded scan of a large file is the kind of cost that freezes the host.
 */
export function hasMaskArtifact(text: string): boolean {
	if (!text.includes("****")) return false;
	return MASK_ARTIFACT_RE.test(text);
}

export type RefSource = "env" | "detected";

export interface SecretRefEntry {
	/** Truncated HMAC of the value. */
	id: string;
	/** Cosmetic type hint. */
	label: string;
	/** Rendered `<secret:label:id>`. */
	ref: string;
	value: string;
	/** Env var names backing this value (fnox). Empty when the value was only detected. */
	names: string[];
	source: RefSource;
}

/** How a ref is expanded. */
export type HydrateMode =
	/** Replace with the secret value. File writes only. */
	| "value"
	/** Replace with `${NAME}`. Requires an env-backed entry. */
	| "env";

export interface HydrateResult {
	text: string;
	/** Entries that were expanded, in order of first appearance. */
	resolved: SecretRefEntry[];
	/** Raw refs that could not be expanded under this mode. */
	unresolved: string[];
}

/**
 * Id lengths tried in order. Truncation makes collisions possible, and aliasing
 * two values under one id would hydrate the wrong secret, so a colliding value
 * gets a longer id instead.
 */
const ID_LENGTHS = [8, 12, 16, 24, 32];

/**
 * A hydrated value can itself contain a ref when the scrubber nested two mints,
 * so hydration repeats until the text settles. The bound stops a pathological
 * self-referencing chain from looping forever.
 */
const MAX_HYDRATE_PASSES = 8;

function normalizeKey(key: string | undefined): string {
	if (key && /^[0-9a-f]{64}$/.test(key)) return key;
	return randomBytes(32).toString("hex");
}

/**
 * Whether `offset` sits inside a single-quoted shell string, where `${NAME}` is
 * literal text rather than an expansion.
 */
function insideSingleQuotes(text: string, offset: number): boolean {
	let quotes = 0;
	for (let i = 0; i < offset; i++) {
		if (text[i] === "'") quotes++;
	}
	return quotes % 2 === 1;
}

/** Turn `<\secret:...>` back into the literal `<secret:...>` it stands for. */
function unescapeRefs(text: string): string {
	return text.replace(/<\\secret:/g, "<secret:");
}

export class SecretRefRegistry implements RefCodec {
	/** Hex session key. Inherited by subagents so parent refs parse in children. */
	readonly key: string;

	private byId = new Map<string, SecretRefEntry>();
	private byName = new Map<string, SecretRefEntry>();

	constructor(key?: string) {
		this.key = normalizeKey(key);
	}

	private digest(value: string): string {
		return createHmac("sha256", Buffer.from(this.key, "hex")).update(value, "utf8").digest("hex");
	}

	hasId(id: string): boolean {
		return this.byId.has(id);
	}

	/**
	 * Register a value and return its entry. Re-registering the same value keeps the
	 * original ref (ids are content-addressed, so the ref is already stable) and
	 * accumulates any further env var names backing it.
	 */
	register(value: string, opts: { label: string; name?: string }): SecretRefEntry {
		const digest = this.digest(value);
		let entry: SecretRefEntry | undefined;
		let id = "";

		for (const length of ID_LENGTHS) {
			const candidate = digest.slice(0, length);
			const existing = this.byId.get(candidate);
			if (!existing) {
				id = candidate;
				break;
			}
			if (existing.value === value) {
				entry = existing;
				break;
			}
		}

		if (!entry) {
			if (!id) throw new Error("secret ref id space exhausted");
			const label = slugLabel(opts.label);
			entry = { id, label, ref: `<secret:${label}:${id}>`, value, names: [], source: "detected" };
			this.byId.set(id, entry);
		}

		if (opts.name && !entry.names.includes(opts.name)) {
			entry.names.push(opts.name);
			entry.source = "env";
			this.byName.set(opts.name, entry);
		}
		return entry;
	}

	/** Register an env-backed secret (fnox). Its authoring ref is `<secret:NAME>`. */
	registerNamed(name: string, value: string): SecretRefEntry {
		return this.register(value, { label: name, name });
	}

	/**
	 * Minter half of the RefCodec. Kept as a bound arrow so it can be handed around
	 * without losing `this`.
	 */
	readonly mint = (value: string, label: string, name?: string): string => this.register(value, { label, name }).ref;

	lookupName(name: string): SecretRefEntry | undefined {
		return this.byName.get(name);
	}

	/** Every raw ref occurring in `text`, escaped ones excluded. */
	scan(text: string): string[] {
		const found: string[] = [];
		for (const match of text.matchAll(refMatcher())) {
			if (match[1]) continue;
			found.push(match[0]);
		}
		return found;
	}

	/**
	 * Expand refs in `text`.
	 *
	 * Unresolvable refs are reported rather than left in place: silently writing an
	 * unexpanded ref to disk is the same class of bug as writing a mask.
	 */
	hydrate(text: string, mode: HydrateMode): HydrateResult {
		const resolved: SecretRefEntry[] = [];
		const expanded = new Set<string>();
		const unresolved = new Set<string>();

		let current = text;
		for (let pass = 0; pass < MAX_HYDRATE_PASSES; pass++) {
			const next = current.replace(
				refMatcher(),
				(raw: string, escape: string, label: string, id: string | undefined, offset: number, whole: string) => {
					if (escape) return raw;

					const entry = id ? this.byId.get(id) : this.byName.get(label);
					if (!entry) {
						unresolved.add(raw);
						return raw;
					}

					if (mode === "env") {
						const name = entry.names[0];
						// No env var to point at, and inlining the value would put it in the
						// process table and the shell history.
						if (!name) {
							unresolved.add(raw);
							return raw;
						}
						// Inside single quotes the shell would write the expansion out as
						// literal text, which looks like it worked and is not.
						if (insideSingleQuotes(whole, offset)) {
							unresolved.add(raw);
							return raw;
						}
						if (!expanded.has(entry.id)) {
							expanded.add(entry.id);
							resolved.push(entry);
						}
						return `\${${name}}`;
					}

					if (!expanded.has(entry.id)) {
						expanded.add(entry.id);
						resolved.push(entry);
					}
					return entry.value;
				},
			);
			if (next === current) break;
			current = next;
		}

		// Anything still referenced after the passes settle is a nested or circular
		// ref; report it instead of writing it.
		for (const raw of this.scan(current)) unresolved.add(raw);

		return { text: unescapeRefs(current), resolved, unresolved: [...unresolved] };
	}
}
