import { copyFileSync, chmodSync, lstatSync, mkdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { AgentRole, BackgroundAgentsConfig, ProviderProfile } from "../../types.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface RoleRuntimeProfile {
	tools: string[];
	thinking: ThinkingLevel;
	toolCapable: boolean;
	writeCapable: boolean;
}

export const DEFAULT_ROLE_RUNTIME_PROFILES: Readonly<Record<AgentRole, RoleRuntimeProfile>> = {
	classifier: { tools: [], thinking: "low", toolCapable: false, writeCapable: false },
	investigator: { tools: ["read", "grep", "find", "ls"], thinking: "medium", toolCapable: true, writeCapable: false },
	"spec-planner": { tools: ["read", "grep", "find", "ls"], thinking: "high", toolCapable: true, writeCapable: false },
	worker: {
		tools: ["read", "write", "edit", "grep", "find", "ls", "bash"],
		thinking: "high",
		toolCapable: true,
		writeCapable: true,
	},
	verifier: {
		tools: ["read", "grep", "find", "ls", "bash"],
		thinking: "high",
		toolCapable: true,
		writeCapable: false,
	},
};

export interface SelectedRuntimeProfile {
	profile: ProviderProfile;
	role: AgentRole;
	model?: string;
	tools: string[];
	thinking: ThinkingLevel;
	agentDir: string;
	sessionDir: string;
}

export interface SelectRuntimeProfileOptions {
	profileId?: string;
	model?: string;
	tools?: string[];
	thinking?: ThinkingLevel;
	attemptDir: string;
}

function requiredPath(value: string, field: string): string {
	if (!value || !isAbsolute(value)) throw new Error(`${field} must be an absolute path`);
	return resolve(value);
}

function profileFor(config: BackgroundAgentsConfig, role: AgentRole, profileId?: string): ProviderProfile {
	const profiles = config.profiles.filter((profile) => profile.allowedRoles.includes(role));
	const profile = profileId ? profiles.find((item) => item.id === profileId) : profiles[0];
	if (!profile)
		throw new Error(profileId ? `profile ${profileId} cannot run role ${role}` : `no profile can run role ${role}`);
	return profile;
}

function selectedModel(profile: ProviderProfile, requested: string | undefined): string | undefined {
	const model = requested ?? profile.allowedModels[0];
	if (model && profile.allowedModels.length > 0 && !profile.allowedModels.includes(model)) {
		throw new Error(`model ${model} is not allowed by profile ${profile.id}`);
	}
	return model;
}

export function selectRuntimeProfile(
	config: BackgroundAgentsConfig,
	role: AgentRole,
	options: SelectRuntimeProfileOptions,
): SelectedRuntimeProfile {
	const profile = profileFor(config, role, options.profileId);
	const defaults = DEFAULT_ROLE_RUNTIME_PROFILES[role];
	const tools = options.tools ? [...options.tools] : [...defaults.tools];
	if (!defaults.toolCapable && tools.length > 0) throw new Error(`${role} is not tool-capable`);
	if (!defaults.writeCapable && tools.some((tool) => !defaults.tools.includes(tool)))
		throw new Error(`${role} is not tool-capable for the requested boundary`);
	if (!defaults.writeCapable && tools.some((tool) => ["write", "edit", "applyPatch"].includes(tool)))
		throw new Error(`${role} is not write-capable`);
	const agentDir = requiredPath(join(options.attemptDir, "pi-profile"), "isolated agent directory");
	const sessionDir = requiredPath(join(options.attemptDir, "sessions"), "session directory");
	return {
		profile,
		role,
		model: selectedModel(profile, options.model),
		tools,
		thinking: options.thinking ?? defaults.thinking,
		agentDir,
		sessionDir,
	};
}

export interface PreparedRuntimeProfile extends SelectedRuntimeProfile {
	environment: { PI_CODING_AGENT_DIR: string; PI_CODING_AGENT_SESSION_DIR: string };
	credentialFiles: string[];
}

/** Copy only explicitly configured credentials into the attempt-owned profile. */
export function prepareRuntimeProfile(
	selected: SelectedRuntimeProfile,
	options: { copyCredentials?: boolean } = {},
): PreparedRuntimeProfile {
	mkdirSync(selected.agentDir, { recursive: true, mode: 0o700 });
	mkdirSync(selected.sessionDir, { recursive: true, mode: 0o700 });
	chmodSync(selected.agentDir, 0o700);
	chmodSync(selected.sessionDir, 0o700);
	const credentialFiles: string[] = [];
	const names = new Set<string>();
	for (const source of options.copyCredentials === false ? [] : selected.profile.authFiles) {
		const sourcePath = requiredPath(source, "credential file");
		const stat = lstatSync(sourcePath);
		if (!stat.isFile()) throw new Error(`credential file is not a regular file: ${sourcePath}`);
		if ((stat.mode & 0o077) !== 0) throw new Error(`credential file is too permissive: ${sourcePath}`);
		const name = basename(sourcePath);
		if (names.has(name)) throw new Error(`credential files have duplicate name: ${name}`);
		names.add(name);
		const destination = join(selected.agentDir, name);
		copyFileSync(sourcePath, destination);
		chmodSync(destination, 0o600);
		credentialFiles.push(destination);
	}
	return {
		...selected,
		environment: {
			PI_CODING_AGENT_DIR: selected.agentDir,
			PI_CODING_AGENT_SESSION_DIR: selected.sessionDir,
		},
		credentialFiles,
	};
}

export const chooseRuntimeProfile = selectRuntimeProfile;
export const prepareIsolatedProfile = prepareRuntimeProfile;
