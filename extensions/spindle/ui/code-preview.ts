import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type DiffBackgroundIntensity = "off" | "subtle" | "medium";
type DiffWordEmphasis = "all" | "smart" | "off";
type ToolCallBackgroundMode = "on" | "border" | "off";
type PathIconMode = "unicode" | "nerd" | "off";
type CodePreviewToolName = "bash" | "read" | "write" | "edit" | "grep" | "find" | "ls";

export interface CodePreviewSettings {
	shikiTheme: string;
	diffIntensity: DiffBackgroundIntensity;
	wordEmphasis: DiffWordEmphasis;
	toolCallBackground: ToolCallBackgroundMode;
	toolCallTiming: boolean;
	readCollapsedLines: number;
	readContentPreview: boolean;
	writeContentPreview: boolean;
	writeCollapsedLines: number;
	editDiffPreview: boolean;
	editCollapsedLines: number | "all";
	grepCollapsedLines: number;
	grepResultPreview: boolean;
	findResultPreview: boolean;
	lsResultPreview: boolean;
	pathListCollapsedLines: number;
	readLineNumbers: boolean;
	bashResultPreview: boolean;
	bashWarnings: boolean;
	syntaxHighlighting: boolean;
	secretWarnings: boolean;
	pathIcons: PathIconMode;
	tools: CodePreviewToolName[];
}

const TOOLS: CodePreviewToolName[] = ["bash", "read", "write", "edit", "grep", "find", "ls"];
const booleanEnv = (name: string, fallback: boolean): boolean => {
	const value = process.env[name]?.toLowerCase();
	if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
	if (value === "0" || value === "false" || value === "no" || value === "off") return false;
	return fallback;
};
const positiveEnv = (name: string, fallback: number): number => {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
};
const optionEnv = <T extends string>(name: string, options: readonly T[], fallback: T): T => {
	const value = process.env[name] as T | undefined;
	return value && options.includes(value) ? value : fallback;
};

export const defaultCodePreviewSettings = (): CodePreviewSettings => ({
	shikiTheme: process.env.CODE_PREVIEW_THEME || "dark-plus",
	diffIntensity: optionEnv("CODE_PREVIEW_DIFF_INTENSITY", ["off", "subtle", "medium"], "subtle"),
	wordEmphasis: optionEnv("CODE_PREVIEW_WORD_EMPHASIS", ["all", "smart", "off"], "all"),
	toolCallBackground: optionEnv("CODE_PREVIEW_TOOL_CALL_BACKGROUND", ["on", "border", "off"], "on"),
	toolCallTiming: booleanEnv("CODE_PREVIEW_TOOL_CALL_TIMING", true),
	readCollapsedLines: positiveEnv("CODE_PREVIEW_READ_LINES", 10),
	readContentPreview: booleanEnv("CODE_PREVIEW_READ_CONTENT", true),
	writeContentPreview: booleanEnv("CODE_PREVIEW_WRITE_CONTENT", true),
	writeCollapsedLines: positiveEnv("CODE_PREVIEW_WRITE_LINES", 10),
	editDiffPreview: booleanEnv("CODE_PREVIEW_EDIT_DIFF", true),
	editCollapsedLines:
		process.env.CODE_PREVIEW_EDIT_LINES === "all" ? "all" : positiveEnv("CODE_PREVIEW_EDIT_LINES", 160),
	grepCollapsedLines: positiveEnv("CODE_PREVIEW_GREP_LINES", 15),
	grepResultPreview: booleanEnv("CODE_PREVIEW_GREP_RESULTS", true),
	findResultPreview: booleanEnv("CODE_PREVIEW_FIND_RESULTS", true),
	lsResultPreview: booleanEnv("CODE_PREVIEW_LS_RESULTS", true),
	pathListCollapsedLines: positiveEnv("CODE_PREVIEW_PATH_LIST_LINES", 20),
	readLineNumbers: booleanEnv("CODE_PREVIEW_READ_LINE_NUMBERS", true),
	bashResultPreview: booleanEnv("CODE_PREVIEW_BASH_RESULTS", true),
	bashWarnings: booleanEnv("CODE_PREVIEW_BASH_WARNINGS", true),
	syntaxHighlighting: booleanEnv("CODE_PREVIEW_SYNTAX", true),
	secretWarnings: booleanEnv("CODE_PREVIEW_SECRET_WARNINGS", true),
	pathIcons: optionEnv("CODE_PREVIEW_PATH_ICONS", ["unicode", "nerd", "off"], "unicode"),
	tools: [...TOOLS],
});

const settingsKeys = new Set<keyof CodePreviewSettings>([
	"shikiTheme",
	"diffIntensity",
	"wordEmphasis",
	"toolCallBackground",
	"toolCallTiming",
	"readCollapsedLines",
	"readContentPreview",
	"writeContentPreview",
	"writeCollapsedLines",
	"editDiffPreview",
	"editCollapsedLines",
	"grepCollapsedLines",
	"grepResultPreview",
	"findResultPreview",
	"lsResultPreview",
	"pathListCollapsedLines",
	"readLineNumbers",
	"bashResultPreview",
	"bashWarnings",
	"syntaxHighlighting",
	"secretWarnings",
	"pathIcons",
	"tools",
]);

const extractSettings = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const object = value as Record<string, unknown>;
	if (object.codePreview && typeof object.codePreview === "object" && !Array.isArray(object.codePreview)) {
		return object.codePreview as Record<string, unknown>;
	}
	if ([...settingsKeys].some((key) => key in object)) return object;
	const result: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(object)) {
		if (!key.startsWith("codePreview") || key.length === 11) continue;
		const suffix = key.slice(11);
		result[suffix[0]!.toLowerCase() + suffix.slice(1)] = nested;
	}
	return result;
};

const applySettings = (current: CodePreviewSettings, raw: Record<string, unknown>): void => {
	for (const key of settingsKeys) {
		const value = raw[key];
		const fallback = current[key];
		if (typeof fallback === "boolean" && typeof value === "boolean") {
			(current as unknown as Record<string, unknown>)[key] = value;
		} else if (typeof fallback === "number" && typeof value === "number" && Number.isFinite(value) && value > 0) {
			(current as unknown as Record<string, unknown>)[key] = Math.floor(value);
		} else if (key === "editCollapsedLines" && value === "all") current.editCollapsedLines = "all";
		else if (key === "tools" && Array.isArray(value))
			current.tools = value.filter(
				(tool): tool is CodePreviewToolName =>
					typeof tool === "string" && TOOLS.includes(tool as CodePreviewToolName),
			);
		else if (key === "diffIntensity" && ["off", "subtle", "medium"].includes(String(value))) {
			current.diffIntensity = value as DiffBackgroundIntensity;
		} else if (key === "wordEmphasis" && ["all", "smart", "off"].includes(String(value))) {
			current.wordEmphasis = value as DiffWordEmphasis;
		} else if (key === "toolCallBackground" && ["on", "border", "off"].includes(String(value))) {
			current.toolCallBackground = value as ToolCallBackgroundMode;
		} else if (key === "pathIcons" && ["unicode", "nerd", "off"].includes(String(value))) {
			current.pathIcons = value as PathIconMode;
		} else if (key === "shikiTheme" && typeof value === "string" && value) {
			current.shikiTheme = value;
		}
	}
};

const readSettings = async (path: string): Promise<Record<string, unknown> | undefined> => {
	try {
		return extractSettings(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`[pi-spindle] Failed to load code preview settings from ${path}.`, error);
		}
		return undefined;
	}
};

export async function loadCodePreviewSettings(
	projectCwd?: string,
	projectTrusted = false,
): Promise<CodePreviewSettings> {
	const settings = defaultCodePreviewSettings();
	const agentDir = getAgentDir();
	const legacyAgentDir = join(homedir(), ".pi", "agent");
	const dedicatedPath = join(agentDir, "code-previews.json");
	const paths = [
		join(homedir(), ".pi", "settings.json"),
		join(legacyAgentDir, "settings.json"),
		join(agentDir, "settings.json"),
		...(projectTrusted ? [join(projectCwd ?? process.cwd(), ".pi", "settings.json")] : []),
		join(legacyAgentDir, "code-previews.json"),
		dedicatedPath,
	];
	const layers = await Promise.all([...new Set(paths)].map(readSettings));
	for (const loaded of layers) {
		if (loaded) applySettings(settings, loaded);
	}
	return { ...settings, tools: [...new Set(settings.tools)] };
}
