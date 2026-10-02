import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const MODEL_SPECS = {
	flash: {
		id: "clef-flash-4bit",
		name: "Clef Flash 9B (MLX 4-bit, local)",
		repo: "mlx-community/clef-flash-4bit",
		revision: "d9ec324f7992383bdfb7a0b4eed8b4b9d10f81be",
	},
	full: {
		id: "clef-4bit",
		name: "Clef 27B (MLX 4-bit, local)",
		repo: "mlx-community/clef-4bit",
		revision: "a1cc3c6d04beed778adbd53bad8899f91d3c0968",
	},
} as const;
export const CLASSIFIER_API = "clef-mlx-classify";

export interface ClefConfig {
	model: keyof typeof MODEL_SPECS;
	python: string;
	modelPath?: string;
	idleTimeoutMs: number;
	requestTimeoutMs: number;
	maxLength: number;
	memoryLimitGB: number;
}

export function normalizeClefConfig(value: Record<string, unknown>): ClefConfig {
	const allowed = new Set([
		"model",
		"python",
		"modelPath",
		"idleTimeoutMs",
		"requestTimeoutMs",
		"maxLength",
		"memoryLimitGB",
	]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`clef.json: unknown setting ${key}`);
	}
	const string = (key: string, fallback?: string): string | undefined => {
		const result = value[key] === undefined ? fallback : value[key];
		if (result === undefined) return undefined;
		if (typeof result !== "string" || !result.trim() || result.includes("\0"))
			throw new Error(`clef.json: ${key} must be a nonempty string`);
		return result.startsWith("~/") ? join(homedir(), result.slice(2)) : result;
	};
	const integer = (key: string, fallback: number, min: number, max: number): number => {
		const result = value[key] === undefined ? fallback : value[key];
		if (typeof result !== "number" || !Number.isSafeInteger(result) || result < min || result > max)
			throw new Error(`clef.json: ${key} must be an integer from ${min} to ${max}`);
		return result;
	};
	const modelPath = string("modelPath");
	const model = value.model === undefined ? "flash" : value.model;
	if (model !== "flash" && model !== "full") throw new Error('clef.json: model must be "flash" or "full"');
	if (modelPath && !isAbsolute(modelPath)) throw new Error("clef.json: modelPath must be an absolute path");
	const python = string("python", "python3")!;
	if (!isAbsolute(python) && /[/\\\s]/.test(python))
		throw new Error("clef.json: python must be an executable name or an absolute path, not a shell command");
	return {
		model,
		python,
		modelPath,
		idleTimeoutMs: integer("idleTimeoutMs", 600_000, 1, 86_400_000),
		requestTimeoutMs: integer("requestTimeoutMs", 180_000, 1, 3_600_000),
		maxLength: integer("maxLength", 8192, 128, 16_384),
		memoryLimitGB: integer("memoryLimitGB", model === "flash" ? 16 : 24, 4, 128),
	};
}
