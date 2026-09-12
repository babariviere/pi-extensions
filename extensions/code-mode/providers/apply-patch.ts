// Copyright 2025 OpenAI. Licensed under Apache-2.0 (see apply-patch.LICENSE).
// Modified: TypeScript/Node filesystem adapter retaining Code Mode's tool contract
// and sandbox guards. Upstream revision and attribution: apply-patch.NOTICE.

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseApplyPatch } from "./apply-patch-parser.ts";
import { type ApplyPatchFileUpdateMode, applyPatchUpdate } from "./apply-patch-update.ts";

export { type ApplyPatchAction, type ApplyPatchHunk, parseApplyPatch } from "./apply-patch-parser.ts";
export type { ApplyPatchFileUpdateMode } from "./apply-patch-update.ts";

export interface ApplyPatchChange {
	kind: "add" | "update" | "delete" | "move";
	path: string;
	moveTo?: string;
}

// Rust read_to_string rejects invalid UTF-8 and retains a UTF-8 BOM.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const writeWithParents = async (path: string, content: string): Promise<void> => {
	try {
		await writeFile(path, content, "utf8");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
	}
};

/** Apply parsed operations in order, including Codex's partial-success semantics. */
export async function applyPatch(
	cwd: string,
	patch: string,
	guard?: (absolutePath: string) => void,
	mode: ApplyPatchFileUpdateMode = process.env.CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS === "1"
		? "preserveLineEndings"
		: "normalizeToLf",
): Promise<ApplyPatchChange[]> {
	const actions = parseApplyPatch(patch);
	if (actions.length === 0) throw new Error("No files were modified.");
	const operations = actions.map((action) => ({
		action,
		path: resolve(cwd, action.path),
		moveTo: action.kind === "update" && action.moveTo !== undefined ? resolve(cwd, action.moveTo) : undefined,
	}));
	// Keep the existing sandbox preflight. File existence and hunk matching,
	// unlike permissions, must be evaluated sequentially to allow repeated paths.
	for (const { path, moveTo } of operations) {
		guard?.(path);
		if (moveTo !== undefined) guard?.(moveTo);
	}
	const changes: ApplyPatchChange[] = [];
	for (const { action, path, moveTo } of operations) {
		// Earlier operations may have changed symlink resolution. Recheck before IO.
		guard?.(path);
		if (moveTo !== undefined) guard?.(moveTo);
		if (action.kind === "add") {
			await writeWithParents(path, action.content);
			changes.push({ kind: "add", path: action.path });
		} else if (action.kind === "delete") {
			await unlink(path);
			changes.push({ kind: "delete", path: action.path });
		} else {
			const original = utf8.decode(await readFile(path));
			const content = applyPatchUpdate(original, path, action.hunks, mode);
			if (moveTo !== undefined) {
				// Codex writes the destination and unlinks the source, rather than
				// renaming. This also supports cross-device moves and symlink targets.
				await writeWithParents(moveTo, content);
				await unlink(path);
				changes.push({ kind: "move", path: action.path, moveTo: action.moveTo });
			} else {
				await writeFile(path, content, "utf8");
				changes.push({ kind: "update", path: action.path });
			}
		}
	}
	return changes;
}

const applyPatchSchema = Type.Object({
	patch: Type.String({
		description: "Codex/OpenAI V4A patch text from *** Begin Patch through *** End Patch",
	}),
});

export const createApplyPatchToolDefinition = (
	cwd: string,
	guard?: (absolutePath: string) => void,
): ToolDefinition<any, any, any> => ({
	name: "applyPatch",
	label: "Apply Patch",
	description:
		"Apply a Codex V4A patch. Supports Add/Update/Delete File, Move to, @@ anchors, context hunks, and End of File. Operations run in order; failures may leave earlier changes applied.",
	parameters: applyPatchSchema,
	async execute(_toolCallId, args) {
		const changes = await applyPatch(cwd, (args as { patch: string }).patch, guard);
		const files = changes.length;
		return {
			content: [
				{
					type: "text" as const,
					text: `Applied patch successfully (${files} file${files === 1 ? "" : "s"} changed)`,
				},
			],
			details: { changes },
		};
	},
});
