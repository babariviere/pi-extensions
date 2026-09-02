/**
 * PORTED (and trimmed) from upstream `src/providers/arg-normalization.ts`.
 *
 * Argument-shape normalization for Spindle providers, mirroring the pi core tool
 * architecture:
 *
 * 1. prepareArguments canonicalizes near-miss argument spellings at the registry
 *    prepare stage — aliases resolve to the canonical key (which wins on
 *    conflict), numeric strings coerce for schema-declared numeric fields, enum
 *    value spellings repair, and nullish values of declared optionals are
 *    stripped.
 * 2. validateArguments then owns the didactic failure tier: unknown keys fail
 *    `additionalProperties: false` validation with the offending path named.
 *
 * Most of the repair surface derives from each action's inputSchema rather than
 * a hand-maintained table: key casing/spacing variants and singular/plural
 * near-misses come from the declared property names, numeric coercion from the
 * declared property types, and enum-value repairs from the declared members.
 */

import type { SpindleActionDescriptor } from "../protocol.ts";

interface JsonSchemaObject {
	type?: unknown;
	properties?: unknown;
	enum?: unknown;
	items?: unknown;
	oneOf?: unknown;
	anyOf?: unknown;
}

export interface ArgNormalizationSpec {
	// Explicit escape-hatch rows. Prefer derivation or a shared synonym class;
	// keep entries here only for action-local semantics.
	aliases?: Readonly<Record<string, string>>;
	numerics?: readonly string[];
	values?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export type ActionArgNormalizer = (actionName: string, args: Record<string, unknown>) => Record<string, unknown>;

// Casing/spacing/underscore-insensitive key and value form, e.g. "run_id",
// "runId", and "RUN-ID" all share one form.
const normalizeForm = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

// Semantic near-miss vocabulary. A spilled key belonging to a class repairs to a
// declared canonical key only when exactly one member of that class is declared
// by the action's schema — ambiguity (or absence) leaves the key untouched so
// the validate stage owns its failure.
const KEY_SYNONYM_CLASSES: ReadonlyArray<ReadonlyArray<string>> = [
	["task", "prompt", "instructions", "instruction", "goal"],
	["agent", "name", "subagent"],
	["runId", "id", "batchId", "handle"],
	["tasks", "items", "jobs", "batch"],
	["query", "q", "search"],
	["limit", "max", "pageSize", "count"],
	["reads", "files", "paths", "context"],
	["output", "outputPath", "destination", "dest"],
	["timeoutMs", "timeout", "deadlineMs"],
	["waitMs", "wait", "blockMs"],
	["server", "host", "target"],
	["tool", "toolName", "action"],
	["args", "arguments", "params", "input"],
];

const KEY_CLASS_FORMS = KEY_SYNONYM_CLASSES.map((cls) => new Set(cls.map(normalizeForm)));

const numericKind = (property: unknown): "scalar" | "array" | undefined => {
	if (!property || typeof property !== "object") return undefined;
	const schema = property as JsonSchemaObject;
	if (schema.type === "number" || schema.type === "integer") return "scalar";
	if (schema.type === "array") {
		const items = schema.items;
		if (
			items &&
			typeof items === "object" &&
			((items as JsonSchemaObject).type === "number" || (items as JsonSchemaObject).type === "integer")
		) {
			return "array";
		}
	}
	return undefined;
};

const stringEnumValues = (property: unknown): readonly string[] | undefined => {
	if (!property || typeof property !== "object") return undefined;
	const schema = property as JsonSchemaObject;
	if (Array.isArray(schema.enum)) {
		const values = schema.enum.filter((entry): entry is string => typeof entry === "string");
		return values.length > 0 ? values : undefined;
	}
	for (const branch of [schema.oneOf, schema.anyOf]) {
		if (!Array.isArray(branch)) continue;
		const consts = branch
			.map((entry) => (entry && typeof entry === "object" ? (entry as { const?: unknown }).const : undefined))
			.filter((entry): entry is string => typeof entry === "string");
		if (consts.length > 0) return consts;
	}
	return undefined;
};

// form -> enum value; exact forms of declared members win.
const deriveEnumValueMap = (values: readonly string[]): Map<string, string> => {
	const map = new Map<string, string>();
	const seen = new Map<string, string | undefined>();
	for (const value of values) {
		const form = normalizeForm(value);
		seen.set(form, seen.has(form) ? undefined : value);
	}
	for (const [form, value] of seen) if (value !== undefined) map.set(form, value);
	return map;
};

interface DerivedAction {
	declared: Set<string>;
	declaredForms: Map<string, string>;
	singulars: Map<string, string>;
	numerics: Set<string>;
	numericArrays: Set<string>;
	values: Map<string, Map<string, unknown>>;
	aliases?: Readonly<Record<string, string>> | undefined;
}

/** The value-column meaning of the schema, precomputed once per action. */
const deriveAction = (
	inputSchema: JsonSchemaObject | undefined,
	explicit: ArgNormalizationSpec | undefined,
): DerivedAction => {
	const properties =
		inputSchema && typeof inputSchema === "object" && inputSchema.properties && typeof inputSchema.properties === "object"
			? (inputSchema.properties as Record<string, unknown>)
			: undefined;
	const declared = new Set(Object.keys(properties ?? {}));
	const declaredForms = new Map<string, string>();
	const ambiguousForms = new Set<string>();
	for (const key of declared) {
		const form = normalizeForm(key);
		if (declaredForms.has(form)) {
			ambiguousForms.add(form);
			declaredForms.delete(form);
		} else if (!ambiguousForms.has(form)) {
			declaredForms.set(form, key);
		}
	}
	const singulars = new Map<string, string>();
	for (const key of declared) {
		const form = normalizeForm(key);
		if (!form.endsWith("s")) continue;
		const singular = form.slice(0, -1);
		if (!singular || declaredForms.has(singular) || singular === form) continue;
		if (singulars.get(singular) !== undefined) singulars.delete(singular);
		else singulars.set(singular, key);
	}
	for (const form of ambiguousForms) singulars.delete(form);

	const numerics = new Set(explicit?.numerics ?? []);
	const numericArrays = new Set<string>();
	const values = new Map<string, Map<string, unknown>>();
	if (properties) {
		for (const [key, property] of Object.entries(properties)) {
			const kind = numericKind(property);
			if (kind === "scalar") numerics.add(key);
			else if (kind === "array") numericArrays.add(key);
			const enumValues = stringEnumValues(property);
			if (enumValues) values.set(key, new Map(deriveEnumValueMap(enumValues)));
		}
	}
	for (const [key, remaps] of Object.entries(explicit?.values ?? {})) {
		const map = values.get(key) ?? new Map<string, unknown>();
		for (const [spelling, target] of Object.entries(remaps)) map.set(normalizeForm(spelling), target);
		values.set(key, map);
	}
	return { declared, declaredForms, singulars, numerics, numericArrays, values, aliases: explicit?.aliases };
};

const lexiconRepair = (form: string, declaredForms: Map<string, string>): string | undefined => {
	const candidates = new Set<string>();
	for (const classForms of KEY_CLASS_FORMS) {
		if (!classForms.has(form)) continue;
		for (const [declaredForm, declaredKey] of declaredForms) {
			if (declaredForm !== form && classForms.has(declaredForm)) candidates.add(declaredKey);
		}
	}
	return candidates.size === 1 ? [...candidates][0] : undefined;
};

const applyDerived = (args: Record<string, unknown>, derived: DerivedAction): Record<string, unknown> => {
	const out: Record<string, unknown> = { ...args };

	// Explicit action-local aliases first, then derived repairs. Both obey
	// canonical-wins: the canonical key keeps an already-supplied value and the
	// spelling variant is dropped either way.
	const repair = (alias: string, canonical: string) => {
		if (!(alias in out) || alias === canonical) return;
		if (!(canonical in out)) out[canonical] = out[alias];
		delete out[alias];
	};
	for (const [alias, canonical] of Object.entries(derived.aliases ?? {})) repair(alias, canonical);
	for (const key of [...Object.keys(out)]) {
		if (derived.declared.has(key)) continue;
		const form = normalizeForm(key);
		const canonical =
			derived.declaredForms.get(form) ?? derived.singulars.get(form) ?? lexiconRepair(form, derived.declaredForms);
		if (canonical && canonical !== key) repair(key, canonical);
	}

	for (const key of derived.numerics) {
		const value = out[key];
		if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) out[key] = Number(value);
	}
	for (const key of derived.numericArrays) {
		const value = out[key];
		if (Array.isArray(value)) {
			out[key] = value.map((entry) =>
				typeof entry === "string" && entry.trim() !== "" && !Number.isNaN(Number(entry)) ? Number(entry) : entry,
			);
		}
	}
	for (const [key, remaps] of derived.values) {
		const value = out[key];
		if (typeof value === "string") {
			const next = remaps.get(normalizeForm(value));
			if (next !== undefined) out[key] = next;
		}
	}
	if (derived.declared.size > 0) {
		for (const key of Object.keys(out)) {
			if (derived.declared.has(key) && (out[key] === null || out[key] === undefined)) delete out[key];
		}
	}
	return out;
};

/**
 * Build a provider `prepareArguments` hook. Repair behavior derives from each
 * action's inputSchema (declared key forms, singular/plural variants, numeric
 * property types, enum value spellings) plus the shared synonym lexicon; the
 * optional table holds only action-local semantics the schema cannot express.
 */
export const actionArgNormalizer = (
	describeActions: () => ReadonlyArray<Pick<SpindleActionDescriptor, "name" | "inputSchema">>,
	table: Record<string, ArgNormalizationSpec> = {},
): ActionArgNormalizer => {
	const derived = new Map<string, DerivedAction>();
	for (const descriptor of describeActions()) {
		derived.set(descriptor.name, deriveAction(descriptor.inputSchema as JsonSchemaObject | undefined, table[descriptor.name]));
	}
	return (actionName, args) => {
		if (!args || typeof args !== "object" || Array.isArray(args)) return args;
		const action = derived.get(actionName);
		return action ? applyDerived(args, action) : args;
	};
};
