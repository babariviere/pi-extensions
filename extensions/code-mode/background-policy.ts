/** Controller-owned, process-level floor for unattended background attempts. */
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
