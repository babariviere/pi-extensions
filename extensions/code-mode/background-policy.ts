/** Controller-owned, process-level floor for unattended background attempts. */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
export type BackgroundRole = "investigator" | "spec-planner" | "worker";

export function backgroundRole(env: NodeJS.ProcessEnv = process.env): BackgroundRole | undefined {
	if (env.PI_BACKGROUND_AGENT_ATTEMPT !== "1") return undefined;
	const role = env.PI_BACKGROUND_AGENT_ROLE;
	if (role === "investigator" || role === "spec-planner" || role === "worker") return role;
	throw new Error("Background Code Mode requires a supported PI_BACKGROUND_AGENT_ROLE");
}

export function assertBackgroundAction(role: BackgroundRole | undefined, ref: string): void {
	if (!role) return;
	const reads = ["pi.read", "pi.grep", "pi.find", "pi.ls"];
	const worker = ["pi.applyPatch", "pi.edit", "pi.write", "pi.bash", "pi.exec"];
	if (reads.includes(ref) || (role === "worker" && worker.includes(ref)) || ref.startsWith("mcp.")) return;
	throw new Error(`Background ${role} cannot invoke ${ref}`);
}

/** Recursive searches of an ancestor could otherwise traverse staged MCP bearer tokens. */
export function assertBackgroundReadPath(
	role: BackgroundRole | undefined,
	ref: string,
	args: Record<string, unknown>,
	cwd: string,
): void {
	if (!role || role === "worker" || !["pi.read", "pi.grep", "pi.find", "pi.ls"].includes(ref)) return;
	const profile = process.env.PI_CODING_AGENT_DIR;
	if (!profile || !isAbsolute(profile)) throw new Error("Background Code Mode requires an isolated agent directory");
	const input = args.path ?? args.file ?? args.dir ?? cwd;
	if (typeof input !== "string") throw new Error("Background read path must be a string");
	const absolute = resolve(cwd, input);
	let path = absolute;
	try {
		path = realpathSync(absolute);
	} catch {
		/* The Pi tool reports missing paths. */
	}
	const inside = (parent: string, child: string): boolean => {
		const difference = relative(parent, child);
		return difference === "" || (difference !== ".." && !difference.startsWith("../") && !isAbsolute(difference));
	};
	if (inside(path, profile) || inside(profile, path))
		throw new Error("Background reads cannot include the isolated credential directory");
}
