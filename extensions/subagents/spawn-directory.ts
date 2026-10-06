/** Validate caller placement without transferring session-only trust to another project. */
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getAgentDir, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SessionRef } from "./session-ref.ts";

export async function resolveSpawnDirectory(
	cwd: string | undefined,
	parent: SessionRef,
): Promise<Pick<SessionRef, "cwd" | "projectTrusted">> {
	if (cwd === undefined) return { cwd: parent.cwd, projectTrusted: parent.projectTrusted };
	if (typeof cwd !== "string" || !cwd.trim() || cwd.includes("\0"))
		throw new Error("spawn cwd must be a non-empty directory path without null characters");
	const expanded = cwd === "~" ? homedir() : cwd.startsWith("~/") ? `${homedir()}${cwd.slice(1)}` : cwd;
	const path = resolve(parent.cwd, expanded);
	let target: string;
	try {
		target = await realpath(path);
		if (!(await stat(target)).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new Error(`spawn cwd must be an existing directory: ${path}`, { cause: error });
	}
	const sameDirectory = target === (await realpath(parent.cwd));
	let projectTrusted = parent.projectTrusted === true;
	if (projectTrusted && !sameDirectory) {
		const agentDir = getAgentDir();
		projectTrusted =
			new ProjectTrustStore(agentDir).get(target) ??
			SettingsManager.create(parent.cwd, agentDir).getDefaultProjectTrust() === "always";
	}
	return { cwd: target, projectTrusted };
}
