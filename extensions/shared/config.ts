import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function merge(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };
	for (const [key, value] of Object.entries(next))
		result[key] = object(value) && object(result[key]) ? merge(result[key], value) : value;
	return result;
}
/** Personal settings plus trusted project settings. Invalid files fail explicitly. */
export function readExtensionConfig(filename: string, ctx: ExtensionContext): Record<string, unknown> {
	let result: Record<string, unknown> = {};
	const paths = [join(getAgentDir(), filename), ...(ctx.isProjectTrusted() ? [join(ctx.cwd, ".pi", filename)] : [])];
	for (const path of paths) {
		try {
			const value: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!object(value)) throw new Error("configuration must be an object");
			result = merge(result, value);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
			throw new Error(`Cannot read ${path}`, { cause: error });
		}
	}
	return result;
}
