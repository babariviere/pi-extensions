import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, win32 } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface ApplyPatchHunk {
	anchors: string[];
	oldLines: string[];
	newLines: string[];
	endOfFile: boolean;
	line: number;
}

export type ApplyPatchAction =
	| { kind: "add"; path: string; content: string; line: number }
	| { kind: "delete"; path: string; line: number }
	| { kind: "update"; path: string; moveTo?: string; hunks: ApplyPatchHunk[]; line: number };

export interface ApplyPatchChange {
	kind: "add" | "update" | "delete" | "move";
	path: string;
	moveTo?: string;
}

const patchError = (line: number, message: string): never => {
	throw new Error(`Invalid patch at line ${line}: ${message}`);
};

const fileHeader = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const isFileBoundary = (line: string): boolean => fileHeader.test(line) || line === "*** End Patch";

/** Parse the Codex/OpenAI V4A patch envelope without touching the filesystem. */
export function parseApplyPatch(patch: string): ApplyPatchAction[] {
	if (typeof patch !== "string") throw new Error("pi.applyPatch patch must be a string");
	const lines = patch.replace(/\r\n/g, "\n").split("\n");
	if (lines[0] !== "*** Begin Patch") patchError(1, "expected '*** Begin Patch'");

	const actions: ApplyPatchAction[] = [];
	let index = 1;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (line === "*** End Patch") {
			if (actions.length === 0) patchError(index + 1, "patch contains no file operations");
			if (lines.slice(index + 1).some((trailing) => trailing !== "")) {
				patchError(index + 2, "unexpected content after '*** End Patch'");
			}
			return actions;
		}

		const header = fileHeader.exec(line);
		if (!header) return patchError(index + 1, "expected an Add, Update, or Delete File header");
		const operation = header[1];
		const path = header[2] ?? "";
		const actionLine = index + 1;
		if (path.length === 0) patchError(actionLine, "file path is empty");
		index += 1;

		if (operation === "Add") {
			const content: string[] = [];
			while (index < lines.length && !isFileBoundary(lines[index] ?? "")) {
				const addition = lines[index] ?? "";
				if (!addition.startsWith("+")) patchError(index + 1, "added file lines must start with '+'");
				content.push(addition.slice(1));
				index += 1;
			}
			actions.push({ kind: "add", path, content: content.join("\n"), line: actionLine });
			continue;
		}

		if (operation === "Delete") {
			if (index < lines.length && !isFileBoundary(lines[index] ?? "")) {
				patchError(index + 1, "Delete File does not accept hunk content");
			}
			actions.push({ kind: "delete", path, line: actionLine });
			continue;
		}

		let moveTo: string | undefined;
		if ((lines[index] ?? "").startsWith("*** Move to: ")) {
			moveTo = (lines[index] ?? "").slice("*** Move to: ".length);
			if (moveTo.length === 0) patchError(index + 1, "move destination is empty");
			index += 1;
		}

		const hunks: ApplyPatchHunk[] = [];
		let reachedEndOfFile = false;
		while (index < lines.length && !isFileBoundary(lines[index] ?? "")) {
			if (reachedEndOfFile) patchError(index + 1, "'*** End of File' must finish the update");
			const anchors: string[] = [];
			const hunkLine = index + 1;
			while ((lines[index] ?? "") === "@@" || (lines[index] ?? "").startsWith("@@ ")) {
				const marker = lines[index] ?? "";
				if (marker !== "@@") anchors.push(marker.slice(3));
				index += 1;
			}
			if (anchors.length === 0 && (lines[hunkLine - 1] ?? "") !== "@@" && hunks.length > 0) {
				patchError(hunkLine, "expected a hunk header beginning with '@@'");
			}

			const oldLines: string[] = [];
			const newLines: string[] = [];
			let changed = false;
			let endOfFile = false;
			while (index < lines.length) {
				const hunkLineText = lines[index] ?? "";
				if (hunkLineText === "*** End of File") {
					endOfFile = true;
					reachedEndOfFile = true;
					index += 1;
					break;
				}
				if (hunkLineText === "@@" || hunkLineText.startsWith("@@ ") || isFileBoundary(hunkLineText)) break;
				if (hunkLineText.startsWith("***")) patchError(index + 1, `unknown patch marker '${hunkLineText}'`);

				const normalized = hunkLineText === "" ? " " : hunkLineText;
				const prefix = normalized[0];
				const text = normalized.slice(1);
				if (prefix === " ") {
					oldLines.push(text);
					newLines.push(text);
				} else if (prefix === "-") {
					oldLines.push(text);
					changed = true;
				} else if (prefix === "+") {
					newLines.push(text);
					changed = true;
				} else {
					patchError(index + 1, "hunk lines must start with ' ', '+', or '-'");
				}
				index += 1;
			}
			if (!changed) patchError(hunkLine, "hunk contains no changes");
			hunks.push({ anchors, oldLines, newLines, endOfFile, line: hunkLine });
		}
		if (hunks.length === 0 && moveTo === undefined) patchError(actionLine, "Update File requires a hunk or Move to");
		actions.push({ kind: "update", path, ...(moveTo !== undefined ? { moveTo } : {}), hunks, line: actionLine });
	}

	return patchError(lines.length, "missing '*** End Patch'");
}

const withoutTrailingWhitespace = (line: string): string => line.replace(/\s+$/u, "");
const lineMatches = (actual: string, expected: string, mode: 0 | 1 | 2): boolean => {
	if (mode === 0) return actual === expected;
	if (mode === 1) return withoutTrailingWhitespace(actual) === withoutTrailingWhitespace(expected);
	return actual.trim() === expected.trim();
};

const findSequence = (lines: string[], expected: string[], start: number, endOfFile: boolean): number => {
	if (expected.length === 0) return endOfFile ? lines.length : start;
	const last = lines.length - expected.length;
	for (const mode of [0, 1, 2] as const) {
		const first = endOfFile ? last : start;
		const limit = endOfFile ? last : last;
		for (let candidate = first; candidate <= limit; candidate += 1) {
			if (candidate < start || candidate < 0) continue;
			if (expected.every((line, offset) => lineMatches(lines[candidate + offset] ?? "", line, mode))) {
				return candidate;
			}
		}
	}
	return -1;
};

const applyUpdate = (content: string, action: Extract<ApplyPatchAction, { kind: "update" }>): string => {
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const normalized = content.replace(/\r\n/g, "\n");
	const hasFinalNewline = normalized.endsWith("\n");
	const lines = normalized.split("\n");
	if (hasFinalNewline) lines.pop();
	let cursor = 0;
	for (const hunk of action.hunks) {
		for (const expectedAnchor of hunk.anchors) {
			const anchor = findSequence(lines, [expectedAnchor], cursor, false);
			if (anchor < 0) {
				throw new Error(
					`Cannot apply ${action.path} hunk at patch line ${hunk.line}: anchor not found: ${expectedAnchor}`,
				);
			}
			cursor = anchor + 1;
		}
		const location = findSequence(lines, hunk.oldLines, cursor, hunk.endOfFile);
		if (location < 0) {
			const context = hunk.oldLines.find((line) => line.trim().length > 0);
			throw new Error(
				`Cannot apply ${action.path} hunk at patch line ${hunk.line}: context not found${context ? ` near '${context}'` : ""}`,
			);
		}
		lines.splice(location, hunk.oldLines.length, ...hunk.newLines);
		cursor = location + hunk.newLines.length;
	}
	return `${lines.join(newline)}${hasFinalNewline && lines.length > 0 ? newline : ""}`;
};

const isInside = (root: string, candidate: string): boolean => {
	const rel = relative(root, candidate);
	return (
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel))
	);
};

const existingAncestor = async (path: string): Promise<string> => {
	let current = path;
	while (true) {
		try {
			await access(current, constants.F_OK);
			return current;
		} catch {
			const parent = dirname(current);
			if (parent === current) return current;
			current = parent;
		}
	}
};

interface WorkspacePath {
	absolute: string;
	identity: string;
}

const workspacePath = async (cwd: string, path: string): Promise<WorkspacePath> => {
	if (path.includes("\0")) throw new Error("Patch paths must not contain NUL bytes");
	if (isAbsolute(path) || win32.isAbsolute(path))
		throw new Error(`Patch path must be relative to the workspace: ${path}`);
	const absolute = resolve(cwd, path);
	if (absolute === resolve(cwd) || !isInside(resolve(cwd), absolute)) {
		throw new Error(`Patch path escapes the workspace: ${path}`);
	}
	const canonicalRoot = await realpath(cwd);
	const ancestor = await existingAncestor(absolute);
	const canonicalAncestor = await realpath(ancestor);
	const canonicalTarget = resolve(canonicalAncestor, relative(ancestor, absolute));
	if (!isInside(canonicalRoot, canonicalTarget))
		throw new Error(`Patch path escapes the workspace through a symlink: ${path}`);
	return { absolute, identity: canonicalTarget };
};

const pathExists = async (path: string): Promise<boolean> => {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
};

interface PreparedChange {
	action: ApplyPatchAction;
	path: string;
	moveTo?: string;
	content?: string;
}

/** Validate every file and hunk before performing the first filesystem mutation. */
const prepareChanges = async (
	cwd: string,
	actions: ApplyPatchAction[],
	guard?: (absolutePath: string) => void,
): Promise<PreparedChange[]> => {
	const prepared: PreparedChange[] = [];
	const claimed = new Map<string, string>();
	for (const action of actions) {
		const source = await workspacePath(cwd, action.path);
		const moveLabel = action.kind === "update" ? action.moveTo : undefined;
		const destination = moveLabel ? await workspacePath(cwd, moveLabel) : undefined;
		for (const [candidate, label] of [
			[source, action.path],
			...(destination && moveLabel ? ([[destination, moveLabel]] as const) : []),
		] as const) {
			const previous = claimed.get(candidate.identity);
			if (previous !== undefined)
				throw new Error(`Patch path is used by multiple operations: ${label} (already used as ${previous})`);
			claimed.set(candidate.identity, label);
			guard?.(candidate.absolute);
		}
		prepared.push({
			action,
			path: source.absolute,
			...(destination ? { moveTo: destination.absolute } : {}),
		});
	}

	for (const change of prepared) {
		const { action, path, moveTo } = change;
		const exists = await pathExists(path);
		if (action.kind === "add") {
			if (exists) throw new Error(`Cannot add ${action.path}: file already exists`);
			change.content = action.content;
			continue;
		}
		if (!exists) throw new Error(`Cannot ${action.kind} ${action.path}: file does not exist`);
		const info = await lstat(path);
		if (!info.isFile() && !info.isSymbolicLink())
			throw new Error(`Cannot ${action.kind} ${action.path}: path is not a file`);
		if (moveTo && (await pathExists(moveTo)))
			throw new Error(`Cannot move ${action.path} to ${moveTo}: destination exists`);
		if (action.kind === "update" && action.hunks.length > 0) {
			const content = await readFile(path, "utf8");
			change.content = applyUpdate(content, action);
		}
	}
	return prepared;
};

export async function applyPatch(
	cwd: string,
	patch: string,
	guard?: (absolutePath: string) => void,
): Promise<ApplyPatchChange[]> {
	const actions = parseApplyPatch(patch);
	const prepared = await prepareChanges(cwd, actions, guard);
	const changes: ApplyPatchChange[] = [];
	for (const change of prepared) {
		const { action, path, moveTo, content } = change;
		if (action.kind === "add") {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content ?? "", "utf8");
			changes.push({ kind: "add", path: action.path });
		} else if (action.kind === "delete") {
			await unlink(path);
			changes.push({ kind: "delete", path: action.path });
		} else if (moveTo) {
			await mkdir(dirname(moveTo), { recursive: true });
			await rename(path, moveTo);
			if (content !== undefined) await writeFile(moveTo, content, "utf8");
			changes.push({ kind: "move", path: action.path, moveTo: action.moveTo });
		} else {
			await writeFile(path, content ?? "", "utf8");
			changes.push({ kind: "update", path: action.path });
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
		"Apply one validated multi-file V4A patch. Supports Add/Update/Delete File, Move to, @@ anchors, context hunks, and End of File.",
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
