/**
 * PORTED (and trimmed) from upstream `src/core/action-repair.ts`.
 *
 * Action-name repair for registry resolution, mirroring the argument-shape
 * repair in `../providers/arg-normalization.ts`:
 *
 * 1. Resolution canonicalizes near-miss action spellings (agents.execute →
 *    agents.run) before the provider descriptor is demanded. The repair surface
 *    is derived from the provider's declared action names — casing, separator
 *    and underscore forms, singular/plural near-misses, camelCase token
 *    alignment, and bounded edit distance — so a new provider gains repair
 *    behavior for free.
 * 2. The failure tier owns the didactic error: an ambiguous or unmatched name
 *    fails with the closest declared candidates named, keeping the original
 *    "Unknown Spindle action" prefix.
 *
 * Only genuinely semantic verb synonyms need explicit vocabulary, and a spilled
 * name repairs only when exactly one declared member fits: ambiguity (or
 * absence) leaves the name untouched so the failure tier can enumerate the
 * honest choices.
 */

interface ActionNameRepair {
	/** Canonical declared action name when exactly one candidate fits. */
	repaired?: string;
	/** Ranked declared candidates for the didactic failure message. */
	suggestions: string[];
}

// Verb/concept classes shared across the registered providers. A class only
// fires when exactly one member is declared by the target provider's catalog.
const ACTION_SYNONYM_CLASSES: ReadonlyArray<ReadonlyArray<string>> = [
	// execution verbs (agents.run).
	["run", "execute", "exec", "invoke", "call", "go", "dispatch"],
	// launch-without-blocking verbs (agents.start).
	["start", "launch", "spawn", "begin", "kick"],
	// list-style catalog reads.
	["list", "ls", "enumerate", "index", "all"],
	// discovery reads.
	["search", "find", "query", "lookup", "grep", "locate"],
	// descriptor reads.
	["describe", "schema", "detail", "details", "explain"],
	// status/introspection reads.
	["status", "info", "inspect", "health", "state"],
	// blocking reads.
	["wait", "join", "await", "poll", "resume"],
	// cancellation verbs.
	["cancel", "abort", "stop", "kill", "terminate"],
	// connection verbs.
	["connect", "open", "attach", "link"],
];

// Casing/spacing/underscore/dollar-insensitive action form, mirroring
// normalizeForm in arg-normalization: "$list" and "list" share a form.
const normalizeActionForm = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

const ACTION_CLASS_FORMS = ACTION_SYNONYM_CLASSES.map((cls) => new Set(cls.map(normalizeActionForm)));

const camelTokens = (name: string): string[] =>
	name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0);

// Singular/plural near-misses collapse to one form.
const singularActionForm = (form: string): string =>
	form.length > 3 && form.endsWith("s") ? form.slice(0, -1) : form;

const levenshtein = (left: string, right: string): number => {
	if (left === right) return 0;
	if (left.length === 0) return right.length;
	if (right.length === 0) return left.length;
	let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
	for (let i = 1; i <= left.length; i++) {
		const current = [i];
		for (let j = 1; j <= right.length; j++) {
			current.push(
				Math.min(
					previous[j]! + 1,
					current[j - 1]! + 1,
					previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
				),
			);
		}
		previous = current;
	}
	return previous[right.length]!;
};

// Edit-distance budget scales with the spilled length; short names keep a tight
// budget so "get" never quietly becomes "set".
const editThreshold = (form: string): number => (form.length <= 4 ? 1 : Math.max(2, Math.floor(form.length / 4)));

const tokenAligned = (spilled: string[], declared: string[]): boolean => {
	if (spilled.length === 0 || spilled.length !== declared.length) return false;
	return spilled.every((token, index) => {
		const other = declared[index]!;
		if (token === other) return true;
		return token.length >= 3 && other.length >= 3 && (token.startsWith(other) || other.startsWith(token));
	});
};

const sortNames = (names: readonly string[]): string[] =>
	[...new Set(names)].sort((left, right) => left.localeCompare(right));

/**
 * Repair a spilled action name against the provider's declared names. Returns
 * the canonical name when exactly one declared candidate fits, or ranked
 * suggestions for the didactic failure message.
 */
export const repairActionName = (declared: readonly string[], actionName: string): ActionNameRepair => {
	const spilledForm = normalizeActionForm(actionName);
	if (spilledForm.length === 0) return { suggestions: [] };
	const rest = declared.filter((name) => name !== actionName);
	if (rest.length === 0) return { suggestions: [] };
	const forms = rest.map((name) => ({ name, form: normalizeActionForm(name) }));

	// Tier 1 — semantic verb classes: repair only when exactly one class member
	// is declared.
	const classCandidates = ACTION_CLASS_FORMS.filter((classForms) => classForms.has(spilledForm)).flatMap(
		(classForms) => forms.filter((entry) => classForms.has(entry.form)).map((entry) => entry.name),
	);
	if (classCandidates.length === 1) return { repaired: classCandidates[0]!, suggestions: [classCandidates[0]!] };
	if (classCandidates.length > 1) return { suggestions: sortNames(classCandidates) };

	// Tier 2 — structural forms derived from the declared names: separator and
	// casing variants, singular/plural, camelCase token alignment, and unique raw
	// prefixes. Weak signals must agree on exactly one canonical name.
	const spilledTokens = camelTokens(actionName);
	const derived: string[] = [];
	for (const entry of forms) {
		if (
			entry.form === spilledForm ||
			singularActionForm(entry.form) === singularActionForm(spilledForm) ||
			(spilledTokens.length > 0 && tokenAligned(spilledTokens, camelTokens(entry.name))) ||
			(spilledForm.length >= 4 && entry.form.startsWith(spilledForm))
		) {
			derived.push(entry.name);
		}
	}
	if (derived.length === 1) return { repaired: derived[0]!, suggestions: [derived[0]!] };
	if (derived.length > 1) return { suggestions: sortNames(derived) };

	// Tier 3 — bounded edit distance with a strict unique minimum.
	const distances = forms.map((entry) => ({ name: entry.name, distance: levenshtein(spilledForm, entry.form) }));
	const min = Math.min(...distances.map((entry) => entry.distance));
	const threshold = editThreshold(spilledForm);
	if (min <= threshold) {
		const nearest = sortNames(distances.filter((entry) => entry.distance === min).map((entry) => entry.name));
		if (nearest.length === 1) return { repaired: nearest[0]!, suggestions: [nearest[0]!] };
		return { suggestions: nearest };
	}

	// Failure tier — rank a few close names so the error teaches the catalog.
	const suggestions = distances
		.filter((entry) => entry.distance <= Math.max(3, Math.floor(spilledForm.length / 2)))
		.sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))
		.slice(0, 3)
		.map((entry) => entry.name);
	return { suggestions: sortNames(suggestions) };
};

/**
 * The didactic unknown-action failure message. The original
 * "Unknown Spindle action: <ref>" prefix is preserved verbatim; declared
 * candidates are appended only when repair found close misses.
 */
export const formatUnknownActionMessage = (ref: string, suggestions: readonly string[]): string =>
	suggestions.length > 0
		? `Unknown Spindle action: ${ref} (did you mean: ${suggestions.slice(0, 3).join(", ")}?)`
		: `Unknown Spindle action: ${ref}`;
