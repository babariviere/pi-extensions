import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { shellQuote } from "./shell.ts";

const CONFIG_FILES = ["mise.toml", ".mise.toml", "mise.local.toml", ".mise.local.toml"];

/** Like mise, include configs inherited from parent directories. Check on every call. */
export function hasMiseConfig(cwd: string): boolean {
	let directory = resolve(cwd);
	for (;;) {
		for (const name of CONFIG_FILES) {
			try {
				if (statSync(join(directory, name)).isFile()) return true;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			}
		}
		const parent = dirname(directory);
		if (parent === directory) return false;
		directory = parent;
	}
}

/** Keep expansion, pipelines, and prefixes inside the mise environment, not the outer shell. */
export function withMise(command: string, cwd: string, shellPath?: string): string {
	if (!hasMiseConfig(cwd)) return command;
	const { shell, args } = getShellConfig(shellPath);
	return `exec mise exec -- ${[shell, ...args, command].map(shellQuote).join(" ")}`;
}
