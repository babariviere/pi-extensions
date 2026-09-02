/**
 * Night read-only MCP mode: the mechanical guard that refuses a write-shaped
 * MCP tool call before it reaches the server.
 *
 * An unattended night run is told in prose never to post to Slack, never to move
 * a Linear ticket, never to touch a Datadog monitor. Prose is not enforcement: a
 * confused subagent can still post to a customer channel. This module is the
 * enforcement, applied at the only two places an MCP tool call can leave the
 * sandbox (`providers/mcp-bridge-provider.ts` for `mcp.*`, and
 * `providers/captured-tools-provider.ts` for the pi-mcp-adapter gateway and its
 * direct tools reached as `extensions.*`).
 *
 * Classification never asks the model at call time. It is decided, in order, by:
 *
 *  1. the server's explicit deny list of known write tools,
 *  2. the server's explicit allow list of known read tools,
 *  3. a conservative name-shape heuristic (`create_`, `send_`, `save_`, ...),
 *  4. `unknownToolPolicy`, which defaults to `deny`.
 *
 * Defaulting the unknown case to `deny` is the whole point: a server that grows a
 * new tool overnight, or a server nobody wrote a profile for, must fail closed.
 * The cost is a read that gets refused with a message saying exactly which line
 * of `spindle.json` would allow it; the alternative cost is a message sent to a
 * customer at 3am. Set `unknownToolPolicy: "allow-reads"` to fall back on the
 * read-shape heuristic instead, or `"allow"` to only block the known writes.
 */

/** What an unlisted tool is worth on a server: nothing, or everything. */
export type McpServerDefault = "deny-writes" | "allow";

/** What happens to a tool that is on no list and has no recognisable shape. */
export type McpUnknownToolPolicy = "deny" | "allow-reads" | "allow";

export interface McpServerPolicy {
	/** `allow` exempts the whole server; `deny-writes` is the default. */
	default?: McpServerDefault;
	/** Known read tools. Loses to `deny`, wins over every heuristic. */
	allow?: readonly string[];
	/** Known write tools. Wins over everything, including `default: "allow"`. */
	deny?: readonly string[];
	/** Per-server override of the global unknown-tool policy. */
	unknownToolPolicy?: McpUnknownToolPolicy;
}

/** The `mcp` block of `spindle.json`. Declarative on purpose: one reviewable place. */
export interface McpReadOnlyConfig {
	/** Master switch. A night run turns it on for its participants. */
	readOnly: boolean;
	unknownToolPolicy: McpUnknownToolPolicy;
	/** Applied to a server with no profile of its own. */
	defaultServerPolicy: McpServerDefault;
	/** Per-server overrides, merged over the built-in profiles below. */
	servers: Record<string, McpServerPolicy>;
}

export const DEFAULT_MCP_READ_ONLY_CONFIG: McpReadOnlyConfig = {
	readOnly: false,
	unknownToolPolicy: "deny",
	defaultServerPolicy: "deny-writes",
	servers: {},
};

/**
 * Built-in profiles for the servers configured here, written from their real
 * tool catalogs rather than guessed. User config is merged over them; the lists
 * are unioned, so a user entry can add but never silently drop a deny.
 *
 * Slack is deliberately total: every tool that can produce a visible artifact
 * (message, draft, scheduled send, reaction, conversation, canvas) is denied by
 * name, and `unknownToolPolicy: "deny"` means a Slack tool nobody has classified
 * yet is refused too.
 */
export const BUILTIN_MCP_SERVER_POLICIES: Readonly<Record<string, McpServerPolicy>> = {
	slack: {
		default: "deny-writes",
		unknownToolPolicy: "deny",
		allow: [
			"slack_search_public",
			"slack_search_public_and_private",
			"slack_search_channels",
			"slack_search_users",
			"slack_search_emojis",
			"slack_read_channel",
			"slack_read_thread",
			"slack_read_canvas",
			"slack_read_user_profile",
			"slack_read_file",
			"slack_list_channel_members",
			"slack_get_reactions",
		],
		deny: [
			"slack_send_message",
			"slack_send_message_draft",
			"slack_schedule_message",
			"slack_add_reaction",
			"slack_create_conversation",
			"slack_create_canvas",
			"slack_update_canvas",
		],
	},
	linear: {
		default: "deny-writes",
		allow: [
			"get_attachment",
			"list_agent_skills",
			"get_agent_skill",
			"list_comments",
			"list_cycles",
			"get_document",
			"list_documents",
			"get_issue",
			"list_issues",
			"list_issue_statuses",
			"get_issue_status",
			"list_issue_labels",
			"list_projects",
			"get_project",
			"list_project_labels",
			"list_release_pipelines",
			"list_releases",
			"get_release",
			"list_release_notes",
			"get_release_note",
			"get_diff",
			"list_diffs",
			"get_diff_threads",
			"list_milestones",
			"get_milestone",
			"list_teams",
			"get_team",
			"list_templates",
			"get_template",
			"list_users",
			"get_user",
			"get_workspace",
			"search_documentation",
			"list_initiatives",
			"get_initiative",
			"list_initiative_labels",
			"get_status_updates",
		],
		deny: [
			"save_issue",
			"save_comment",
			"delete_comment",
			"save_document",
			"save_project",
			"save_release",
			"save_release_note",
			"save_milestone",
			"save_initiative",
			"save_status_update",
			"delete_status_update",
			"save_diff_comment",
			"delete_diff_comment",
			"resolve_diff_thread",
			"submit_diff_review",
			"merge_diff",
			"share_issue",
			"unshare_issue",
			"create_issue_label",
			"create_initiative_label",
			"create_attachment",
			"create_attachment_from_upload",
			"prepare_attachment_upload",
			"delete_attachment",
		],
	},
	datadog: {
		default: "deny-writes",
		allow: [
			"_dd_gff",
			"_dd_guc",
			"_dd_rfw",
			"aggregate_events",
			"aggregate_rum_events",
			"aggregate_spans",
			"analyze_datadog_logs",
			"get_change_stories",
			"get_datadog_dashboard",
			"get_datadog_incident",
			"get_datadog_metric",
			"get_datadog_metric_context",
			"get_datadog_notebook",
			"get_datadog_trace",
			"list_datadog_skills",
			"load_datadog_skill",
			"search_datadog_dashboards",
			"search_datadog_entities",
			"search_datadog_events",
			"search_datadog_hosts",
			"search_datadog_incidents",
			"search_datadog_logs",
			"search_datadog_metrics",
			"search_datadog_monitors",
			"search_datadog_notebooks",
			"search_datadog_rum_events",
			"search_datadog_spans",
		],
		// Not all of these are exposed today. They are listed anyway so enabling a
		// mutating Datadog tool later cannot quietly become allowed.
		deny: [
			"create_datadog_monitor",
			"update_datadog_monitor",
			"delete_datadog_monitor",
			"mute_datadog_monitor",
			"unmute_datadog_monitor",
			"create_datadog_dashboard",
			"update_datadog_dashboard",
			"delete_datadog_dashboard",
			"create_datadog_incident",
			"update_datadog_incident",
			"add_datadog_incident_note",
			"create_datadog_notebook",
			"update_datadog_notebook",
			"post_datadog_event",
		],
	},
	metabase: {
		default: "deny-writes",
		allow: [
			"SEARCH",
			"LIST_DASHBOARDS",
			"LIST_CARDS_FROM_DASHBOARD",
			"GET_PARAM_ALLOWED_VALUES",
			"GET_CARD_DEFINITION",
			"GET_CARD_SQL",
			"GET_DASHBOARD_CARD_DATA",
			"GET_CARD_DATA",
			"LIST_SCHEMAS",
			"LIST_TABLES",
			"LIST_TABLE_COLUMNS",
			"GET_TABLE_SQL",
			"GET_TABLE_DATA",
			"USAGE_GUIDE",
			"QUERY_BUILDER_GUIDE",
		],
		// EXECUTE_SQL_QUERY runs arbitrary SQL, so it is a write tool as far as this
		// guard is concerned, whatever the statement happens to say.
		deny: ["CREATE_NEW_CARD", "UPDATE_CARD", "SETTINGS", "EXECUTE_SQL_QUERY"],
	},
};

/**
 * Verbs that mark a call as write-shaped. Matched against whole name segments,
 * not as a raw substring: `slack_add_reaction` is a write because of `add`,
 * while `slack_get_reactions` is not a write because `reactions` is not `react`.
 */
const WRITE_VERBS: ReadonlySet<string> = new Set([
	"create",
	"update",
	"delete",
	"send",
	"post",
	"add",
	"remove",
	"set",
	"archive",
	"move",
	"assign",
	"react",
	"reply",
	"mutate",
	"write",
	"save",
	"edit",
	"merge",
	"submit",
	"resolve",
	"share",
	"unshare",
	"schedule",
	"execute",
	"upload",
	"prepare",
	"import",
	"mute",
	"unmute",
	"close",
	"cancel",
	"trigger",
	"rename",
	"revoke",
	"grant",
	"publish",
	"invite",
	"restore",
	"apply",
	"patch",
	"put",
]);

/** Verbs that mark a call as read-shaped, used only by `allow-reads`. */
const READ_VERBS: ReadonlySet<string> = new Set([
	"get",
	"list",
	"search",
	"read",
	"fetch",
	"describe",
	"query",
	"show",
	"view",
	"count",
	"aggregate",
	"analyze",
	"load",
	"find",
]);

export type McpToolShape = "read" | "write" | "unknown";

/** `slack_send_message` -> `["slack", "send", "message"]`, `saveIssue` -> `["save", "issue"]`. */
const segmentsOf = (tool: string): string[] =>
	tool
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);

/**
 * Shape of a tool name, with no knowledge of the server and no model judgement.
 * A write verb anywhere in the name wins: refusing a read that happens to be
 * called `get_post` is cheap, sending a message is not.
 */
export const classifyMcpToolName = (tool: string): McpToolShape => {
	const segments = segmentsOf(tool);
	if (segments.some((segment) => WRITE_VERBS.has(segment))) return "write";
	// The verb is first (`get_issue`) or second (`slack_read_thread`); anything
	// further in is too weak a signal to call a read.
	if (segments.slice(0, 2).some((segment) => READ_VERBS.has(segment))) return "read";
	return "unknown";
};

const lower = (value: string): string => value.trim().toLowerCase();

/**
 * pi-mcp-adapter registers every MCP tool under a server-prefixed name
 * (`formatToolName`, whose default `toolPrefix` is `"server"`), so the name that
 * actually reaches this guard is `slack_slack_read_channel`,
 * `linear_list_teams` or `datadog_search_datadog_logs`, and the namespace proxy
 * puts `mcp__slack` on top of that. The built-in profiles are keyed by the names
 * the servers publish in their own catalogs (`slack_read_channel`,
 * `list_teams`), so a literal comparison never matched and every read fell
 * through to `unknownToolPolicy: "deny"`.
 *
 * Rather than duplicating every profile entry once per prefix, a name is reduced
 * to the set of names it could mean: itself, plus itself with any known server
 * prefix peeled off, repeatedly (the Slack catalog already self-prefixes, hence
 * the doubled `slack_slack_`). Deny is evaluated over the whole set before
 * allow, so peeling can only ever surface an extra deny, never launder a write
 * into a read.
 */
const stripPrefix = (tool: string, prefix: string): string | undefined => {
	const head = `${prefix}_`;
	const trimmed = tool.trim();
	return lower(trimmed).startsWith(lower(head)) && trimmed.length > head.length
		? trimmed.slice(head.length)
		: undefined;
};

/** Guard against a pathological name generating an unbounded variant fan-out. */
const MAX_TOOL_NAME_VARIANTS = 8;

/** `slack_slack_read_channel` -> `["slack_slack_read_channel", "slack_read_channel", "read_channel"]`. */
export const mcpToolNameVariants = (tool: string, serverNames: readonly string[] = []): string[] => {
	const prefixes = new Set<string>(["mcp"]);
	for (const name of serverNames) {
		const normalized = name.trim().replace(/-/g, "_");
		if (!normalized) continue;
		prefixes.add(name.trim());
		prefixes.add(normalized);
		prefixes.add(`mcp_${normalized}`);
	}
	const variants: string[] = [];
	const queue: string[] = [tool.trim()];
	while (queue.length > 0 && variants.length < MAX_TOOL_NAME_VARIANTS) {
		const current = queue.shift();
		if (!current || variants.some((entry) => lower(entry) === lower(current))) continue;
		variants.push(current);
		for (const prefix of prefixes) {
			const stripped = stripPrefix(current, prefix);
			if (stripped) queue.push(stripped);
		}
	}
	return variants;
};

const listHas = (list: readonly string[] | undefined, variants: readonly string[]): boolean =>
	(list ?? []).some((entry) => variants.some((variant) => lower(entry) === lower(variant)));

/** Built-in profile merged with the configured one; lists are unioned. */
const policyFor = (server: string | undefined, config: McpReadOnlyConfig): McpServerPolicy => {
	const builtin = server ? BUILTIN_MCP_SERVER_POLICIES[server] : undefined;
	const configured = server ? config.servers[server] : undefined;
	return {
		...((configured?.default ?? builtin?.default) ? { default: configured?.default ?? builtin?.default } : {}),
		allow: [...(builtin?.allow ?? []), ...(configured?.allow ?? [])],
		deny: [...(builtin?.deny ?? []), ...(configured?.deny ?? [])],
		...((configured?.unknownToolPolicy ?? builtin?.unknownToolPolicy)
			? { unknownToolPolicy: configured?.unknownToolPolicy ?? builtin?.unknownToolPolicy }
			: {}),
	};
};

/**
 * Which server owns `tool`, when the caller did not say. The gateway resolves an
 * unqualified tool name itself, so the guard has to do the same lookup or it
 * would judge a Slack write against the global default.
 */
const knownServerNames = (config: McpReadOnlyConfig): string[] => [
	...new Set([...Object.keys(BUILTIN_MCP_SERVER_POLICIES), ...Object.keys(config.servers)]),
];

const inferServer = (tool: string, config: McpReadOnlyConfig): string | undefined => {
	const names = knownServerNames(config);
	const variants = mcpToolNameVariants(tool, names);
	for (const name of names) {
		const policy = policyFor(name, config);
		if (listHas(policy.deny, variants) || listHas(policy.allow, variants)) return name;
	}
	// Nothing classified it, but the adapter's prefix still says who owns it:
	// `slack_<anything>` is a Slack tool and must inherit Slack's total deny.
	for (const name of names) {
		if (stripPrefix(tool, name) || stripPrefix(tool, `mcp_${name.replace(/-/g, "_")}`)) return name;
	}
	return undefined;
};

/** Write wins over read: a name that is write-shaped under any prefix is a write. */
const shapeOfVariants = (variants: readonly string[]): McpToolShape => {
	if (variants.some((variant) => classifyMcpToolName(variant) === "write")) return "write";
	if (variants.some((variant) => classifyMcpToolName(variant) === "read")) return "read";
	return "unknown";
};

export type McpDecisionRule =
	| "read-only-off"
	| "tool-deny"
	| "tool-allow"
	| "server-allow"
	| "write-shape"
	| "read-shape"
	| "unknown-tool";

export interface McpCallDecision {
	allowed: boolean;
	tool: string;
	server: string | undefined;
	rule: McpDecisionRule;
	/** Human-readable justification, quoted verbatim in the refusal. */
	reason: string;
}

/** Decide a single MCP call. Pure, so the whole policy is testable by name. */
export const decideMcpCall = (input: {
	tool: string;
	server?: string | undefined;
	config: McpReadOnlyConfig;
}): McpCallDecision => {
	const tool = input.tool.trim();
	const config = input.config;
	if (!config.readOnly) {
		return { allowed: true, tool, server: input.server, rule: "read-only-off", reason: "read-only mode is off" };
	}
	const server = input.server?.trim() || inferServer(tool, config);
	const policy = policyFor(server, config);
	const where = server ? `server '${server}'` : "an unconfigured server";
	const variants = mcpToolNameVariants(tool, knownServerNames(config));

	if (listHas(policy.deny, variants)) {
		return { allowed: false, tool, server, rule: "tool-deny", reason: `it is on the deny list for ${where}` };
	}
	if (listHas(policy.allow, variants)) {
		return { allowed: true, tool, server, rule: "tool-allow", reason: `it is on the allow list for ${where}` };
	}
	if ((policy.default ?? config.defaultServerPolicy) === "allow") {
		return { allowed: true, tool, server, rule: "server-allow", reason: `${where} is exempt from read-only mode` };
	}

	const shape = shapeOfVariants(variants);
	if (shape === "write") {
		return { allowed: false, tool, server, rule: "write-shape", reason: "its name is write-shaped" };
	}
	const unknownToolPolicy = policy.unknownToolPolicy ?? config.unknownToolPolicy;
	if (unknownToolPolicy === "allow") {
		return { allowed: true, tool, server, rule: "unknown-tool", reason: `unknown tools are allowed for ${where}` };
	}
	if (unknownToolPolicy === "allow-reads" && shape === "read") {
		return { allowed: true, tool, server, rule: "read-shape", reason: "its name is read-shaped" };
	}
	return {
		allowed: false,
		tool,
		server,
		rule: "unknown-tool",
		reason: `it is not on the read allow list for ${where} and unknown tools are denied`,
	};
};

/**
 * The gate the providers hold. One object owns the decision, so the two call
 * paths cannot drift apart.
 */
export class McpReadOnlyGate {
	private constructor(readonly config: McpReadOnlyConfig) {}

	static of(config: McpReadOnlyConfig): McpReadOnlyGate {
		return new McpReadOnlyGate(config);
	}

	/** A gate that permits everything, for a session with no read-only mode. */
	static unrestricted(): McpReadOnlyGate {
		return new McpReadOnlyGate(DEFAULT_MCP_READ_ONLY_CONFIG);
	}

	get readOnly(): boolean {
		return this.config.readOnly;
	}

	decide(tool: string, server?: string): McpCallDecision {
		return decideMcpCall({ tool, server, config: this.config });
	}

	/**
	 * Throw when the call is refused. The message names the tool, the server and
	 * the rule, and says how to allow it: a refusal an agent can report and act on,
	 * never a silent no-op.
	 */
	assert(tool: string, server?: string): void {
		const decision = this.decide(tool, server);
		if (decision.allowed) return;
		const label = decision.server ? `${decision.server}.${decision.tool}` : decision.tool;
		const scope = decision.server ?? "<server>";
		throw new Error(
			`MCP call ${label} is refused: read-only MCP mode is on and ${decision.reason}. ` +
				"An unattended night run may read from MCP servers but must not write. " +
				`Use a read tool instead, report the intended change in your final message, or add '${decision.tool}' to ` +
				`mcp.servers.${scope}.allow in spindle.json.`,
		);
	}
}

/**
 * Gate a call made through the pi-mcp-adapter gateway tool, whose arguments are
 * `{ tool, args, server }`. The management shapes (`search`, `describe`,
 * `connect`, a bare list) carry no tool to call and are reads, so they pass.
 */
export const assertMcpGatewayArguments = (
	gate: McpReadOnlyGate,
	args: Record<string, unknown>,
	/** Server implied by the tool itself, e.g. the `mcp__slack` namespace proxy. */
	defaultServer?: string,
): void => {
	const tool = typeof args.tool === "string" && args.tool.trim() ? args.tool.trim() : undefined;
	if (!tool) return;
	const server = typeof args.server === "string" && args.server.trim() ? args.server.trim() : defaultServer;
	gate.assert(tool, server);
};

/** `mcp__slack` -> `slack`; anything else is not a namespace proxy. */
export const mcpNamespaceProxyServer = (toolName: string): string | undefined => {
	const match = /^mcp__([A-Za-z0-9_]+)$/.exec(toolName.trim());
	return match?.[1];
};

const asRecord = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const stringList = (value: unknown): string[] | undefined =>
	Array.isArray(value)
		? value
				.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
				.map((e) => e.trim())
		: undefined;

const serverDefault = (value: unknown): McpServerDefault | undefined =>
	value === "allow" || value === "deny-writes" ? value : undefined;

const unknownPolicy = (value: unknown): McpUnknownToolPolicy | undefined =>
	value === "deny" || value === "allow" || value === "allow-reads" ? value : undefined;

/** Narrow an untrusted `spindle.json` `mcp` block. Junk falls back to the defaults. */
export const normalizeMcpReadOnlyConfig = (input: unknown): McpReadOnlyConfig => {
	const record = asRecord(input);
	const servers: Record<string, McpServerPolicy> = {};
	for (const [name, value] of Object.entries(asRecord(record.servers))) {
		const entry = asRecord(value);
		const allow = stringList(entry.allow);
		const deny = stringList(entry.deny);
		const fallback = serverDefault(entry.default);
		const unknown = unknownPolicy(entry.unknownToolPolicy);
		servers[name] = {
			...(fallback ? { default: fallback } : {}),
			...(allow ? { allow } : {}),
			...(deny ? { deny } : {}),
			...(unknown ? { unknownToolPolicy: unknown } : {}),
		};
	}
	return {
		readOnly: typeof record.readOnly === "boolean" ? record.readOnly : DEFAULT_MCP_READ_ONLY_CONFIG.readOnly,
		unknownToolPolicy: unknownPolicy(record.unknownToolPolicy) ?? DEFAULT_MCP_READ_ONLY_CONFIG.unknownToolPolicy,
		defaultServerPolicy:
			serverDefault(record.defaultServerPolicy) ?? DEFAULT_MCP_READ_ONLY_CONFIG.defaultServerPolicy,
		servers,
	};
};

/**
 * The night floor: a run that asked for read-only MCP turns it on, and nothing
 * in `spindle.json` can turn it back off for the duration. Mirrors how the
 * filesystem sandbox treats a night request (see `sandbox/resolve.ts`).
 */
export const effectiveMcpReadOnlyConfig = (config: McpReadOnlyConfig, nightReadOnly: boolean): McpReadOnlyConfig =>
	nightReadOnly && !config.readOnly ? { ...config, readOnly: true } : config;
