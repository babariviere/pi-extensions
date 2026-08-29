/**
 * Discover custom agent markdown files and resolve name collisions.
 *
 * Sources:
 *   - user scope:    $PI_CODING_AGENT_DIR/agents/**\/*.md  (default ~/.pi/agent/agents)
 *   - project scope: <cwd>/.pi/agents/**\/*.md
 *
 * Project scope overrides user scope when two files resolve to the same runtime
 * `name`. A single malformed file never aborts discovery.
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentConfig, parseFrontmatter, toAgentConfig } from "./frontmatter.ts";

export type AgentScope = "project" | "user" | "builtin";

export interface DiscoveredAgent {
	config: AgentConfig;
	systemPrompt: string;
	sourcePath: string;
	scope: AgentScope;
}

/**
 * Name of the built-in personaless agent. A run that omits `agent` binds to
 * this instead of erroring: an empty system prompt, no tool narrowing, and no
 * model/thinking pins, so the child inherits everything from the parent
 * session. Users can shadow it by defining their own `task` agent on disk.
 */
export const BUILTIN_AGENT_NAME = "task";

/** The synthetic `DiscoveredAgent` backing personaless runs. */
export function builtinAgent(): DiscoveredAgent {
	return {
		config: {
			name: BUILTIN_AGENT_NAME,
			description: "Generic subagent with no persona; inherits the parent model, tools, skills and project context",
		},
		systemPrompt: "",
		sourcePath: "<builtin>",
		scope: "builtin",
	};
}

/**
 * Append the built-in agent unless a discovered file already claims its name,
 * so an on-disk `task` agent shadows it exactly like project scope shadows user
 * scope.
 */
export function withBuiltinAgent(agents: DiscoveredAgent[]): DiscoveredAgent[] {
	if (agents.some((a) => a.config.name === BUILTIN_AGENT_NAME)) return agents;
	return [...agents, builtinAgent()].sort((a, b) => a.config.name.localeCompare(b.config.name));
}

function agentRootDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getUserAgentsDir(): string {
	return join(agentRootDir(), "agents");
}

export function getProjectAgentsDir(cwd: string): string {
	return join(cwd, ".pi", "agents");
}

/** Recursively collect `*.md` file paths under a directory. */
function walkMarkdown(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkMarkdown(full));
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
			out.push(full);
		}
	}
	return out;
}

function loadAgentFile(path: string, scope: AgentScope): DiscoveredAgent | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
	try {
		const { data, body } = parseFrontmatter(raw);
		const fallbackName = fileStem(path);
		const config = toAgentConfig(data, fallbackName);
		if (!config.name) return undefined;
		return { config, systemPrompt: body.trim(), sourcePath: path, scope };
	} catch {
		// A single bad file must not crash discovery.
		return undefined;
	}
}

function fileStem(path: string): string {
	const base = path.split(/[/\\]/).pop() ?? path;
	return base.replace(/\.md$/i, "");
}

/**
 * Discover agents from both scopes and resolve by runtime name.
 * Project scope wins over user scope on collision.
 */
export function discoverAgents(userAgentsDir: string, projectAgentsDir: string): DiscoveredAgent[] {
	const byName = new Map<string, DiscoveredAgent>();

	// User first, then project overrides.
	for (const path of walkMarkdown(userAgentsDir)) {
		const agent = loadAgentFile(path, "user");
		if (agent) byName.set(agent.config.name, agent);
	}
	for (const path of walkMarkdown(projectAgentsDir)) {
		const agent = loadAgentFile(path, "project");
		if (agent) byName.set(agent.config.name, agent);
	}

	return [...byName.values()].sort((a, b) => a.config.name.localeCompare(b.config.name));
}

/**
 * Convenience wrapper resolving both scopes from the current cwd, plus the
 * built-in personaless agent. Never returns an empty list.
 */
export function discoverAgentsForCwd(cwd: string): DiscoveredAgent[] {
	return withBuiltinAgent(discoverAgents(getUserAgentsDir(), getProjectAgentsDir(cwd)));
}
