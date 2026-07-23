/**
 * Hand-rolled frontmatter parser for the flat agent markdown files used by pi.
 *
 * The agent files use a simple `---`-delimited YAML-ish block with only:
 *   - scalar strings (`model: claude-opus-4-8`)
 *   - comma lists (`tools: read, grep, find`)
 *   - booleans (`inheritSkills: false`)
 *
 * We deliberately do NOT pull in a YAML dependency. Anything we do not
 * understand (nested maps, quoted multiline values, sequences) is ignored so a
 * single malformed field never crashes discovery.
 */

export type FrontmatterValue = string | string[] | boolean;

export interface ParsedFrontmatter {
	data: Record<string, FrontmatterValue>;
	body: string;
}

export interface AgentConfig {
	name: string;
	description?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	systemPromptMode?: "replace" | "append";
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	output?: string;
	defaultReads?: string[];
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

/** Split the leading `---` block from the markdown body. */
export function parseFrontmatter(md: string): ParsedFrontmatter {
	const match = FRONTMATTER_RE.exec(md);
	if (!match) {
		return { data: {}, body: md.replace(/^\uFEFF/, "") };
	}
	const block = match[1];
	const body = md.slice(match[0].length);
	const data: Record<string, FrontmatterValue> = {};

	for (const rawLine of block.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line.trim()) continue;
		// Skip list items / nested maps; we only understand `key: value` scalars.
		if (/^\s/.test(rawLine) || line.trimStart().startsWith("-")) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		if (!key) continue;
		const rawValue = line.slice(colon + 1).trim();
		if (rawValue === "") continue; // block scalar / nested value: ignore
		data[key] = coerceValue(rawValue);
	}

	return { data, body };
}

function stripQuotes(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

function coerceValue(raw: string): FrontmatterValue {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw.includes(",")) {
		const parts = raw
			.split(",")
			.map((p) => stripQuotes(p.trim()))
			.filter((p) => p.length > 0);
		if (parts.length > 1) return parts;
		return parts[0] ?? "";
	}
	return stripQuotes(raw);
}

function asString(value: FrontmatterValue | undefined): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.join(",");
	if (typeof value === "boolean") return String(value);
	return undefined;
}

function asStringList(value: FrontmatterValue | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return value.length ? value : undefined;
	if (typeof value === "string") {
		const parts = value
			.split(",")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
		return parts.length ? parts : undefined;
	}
	return undefined;
}

function asBool(value: FrontmatterValue | undefined): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

/** Map raw frontmatter data to a typed agent config, ignoring unknown keys. */
export function toAgentConfig(data: Record<string, FrontmatterValue>, fallbackName: string): AgentConfig {
	const name = asString(data.name)?.trim() || fallbackName;
	const modeRaw = asString(data.systemPromptMode)?.trim();
	const systemPromptMode = modeRaw === "replace" || modeRaw === "append" ? modeRaw : undefined;

	return {
		name,
		description: asString(data.description)?.trim(),
		model: asString(data.model)?.trim(),
		thinking: asString(data.thinking)?.trim(),
		tools: asStringList(data.tools),
		systemPromptMode,
		inheritProjectContext: asBool(data.inheritProjectContext),
		inheritSkills: asBool(data.inheritSkills),
		output: asString(data.output)?.trim(),
		defaultReads: asStringList(data.defaultReads),
	};
}
