/** Official core-tool overrides. Results, schemas, renderers and middleware stay owned by Pi. */
import { existsSync, realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createLocalBashOperations,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
	type BashToolOptions,
	type ReadToolOptions,
} from "@earendil-works/pi-coding-agent";
import type { SandboxController } from "./controller.ts";
import { isInside } from "./policy.ts";

export const NATIVE_SANDBOX_TOOL_NAMES = ["read", "bash", "edit", "write", "find", "grep", "ls"] as const;

/** Match Pi's public tool path syntax, including its screenshot filename fallbacks. */
export function nativeToolPath(input: string, cwd: string): string {
	const normalized = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
	if (normalized.startsWith("file://")) return fileURLToPath(normalized);
	// Enforcement is macOS-only. Refuse alternate Windows shell paths rather
	// than incorrectly classify a native drive translation as a local child.
	if (process.platform === "win32") throw new Error("sandbox: native path guards do not support Windows");
	return resolve(
		cwd,
		normalized === "~" ? homedir() : normalized.startsWith("~/") ? join(homedir(), normalized.slice(2)) : normalized,
	);
}

function canonicalRoot(input: string): string {
	let existing = input;
	while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
	// Errors (including dangling symlinks) must not turn into an unchecked search.
	return resolve(realpathSync(existing), input.slice(existing.length).replace(/^\//, ""));
}

export function assertNativeReadPath(
	sandbox: SandboxController,
	name: string,
	args: Record<string, unknown>,
	cwd: string,
): void {
	if (!sandbox.enforcing) return;
	const input = args.path ?? ".";
	if (typeof input !== "string") throw new Error("sandbox: read path must be a string");
	const absolute = nativeToolPath(input, cwd);
	const guard = sandbox.readGuard();
	guard(absolute);
	if (name === "read") {
		// Pi resolves these alternatives before reading. Guard them too without
		// replacing its image detection, resize profile or truncation behavior.
		const variants = [
			absolute.replace(/ (AM|PM)\./g, "\u202f$1."),
			absolute.normalize("NFD"),
			absolute.replace(/'/g, "\u2019"),
		];
		variants.push(absolute.normalize("NFD").replace(/'/g, "\u2019"));
		for (const variant of variants) guard(variant);
		return;
	}
	// Core grep/fd spawn their own subprocesses and expose no spawn hook.
	// Refuse ancestor searches rather than let them traverse denied descendants.
	// Narrow searches elsewhere still use the exact native result format.
	const root = canonicalRoot(absolute);
	for (const denied of sandbox.policy.denyRead) {
		if (isInside(root, canonicalRoot(denied))) {
			throw new Error(
				`sandbox: ${name} of ${absolute} could include denied read root ${denied}; choose a narrower path`,
			);
		}
	}
}

export function createNativeSandboxTools(
	cwd: string,
	current: () => SandboxController,
	options: { bash?: BashToolOptions; read?: ReadToolOptions } = {},
): ToolDefinition<any, any>[] {
	const localBash = createLocalBashOperations({ shellPath: options.bash?.shellPath });
	const editOperations = {
		readFile: async (path: string) => {
			current().readGuard()(path);
			return readFile(path);
		},
		access: async (path: string) => {
			current().readGuard()(path);
			current().writeGuard()(path);
			await access(path);
		},
		writeFile: (path: string, content: string) => current().editOperations().writeFile(path, content),
	};
	const definitions: ToolDefinition<any, any>[] = [
		createReadToolDefinition(cwd, options.read),
		createBashToolDefinition(cwd, {
			...options.bash,
			operations: {
				exec: (command, directory, execution) => {
					const sandbox = current();
					return (sandbox.enforcing ? sandbox.bashOperations() : localBash).exec(command, directory, execution);
				},
			},
		}),
		createEditToolDefinition(cwd, { operations: editOperations }),
		createWriteToolDefinition(cwd, {
			operations: {
				mkdir: (path) => current().writeOperations().mkdir(path),
				writeFile: (path, content) => current().writeOperations().writeFile(path, content),
			},
		}),
		createFindToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createLsToolDefinition(cwd),
	];
	return definitions.map((definition) => ({
		...definition,
		// Do not activate tools omitted by --tools/defaultTools when overriding.
		defaultActive: false,
		async execute(id, params, signal, update, ctx) {
			const sandbox = current();
			if (["read", "grep", "find", "ls"].includes(definition.name)) {
				assertNativeReadPath(sandbox, definition.name, params as Record<string, unknown>, ctx.cwd);
			}
			return definition.execute(id, params, signal, update, ctx);
		},
	}));
}
