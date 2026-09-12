import type { SourceEventResult } from "../database.ts";
import { type SourceAdapter, type SourceAdapterOptions, fingerprint, persistSourceEvent } from "./source.ts";

export interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description?: string | null;
	url?: string | null;
	updatedAt?: string | null;
	state?: { id?: string; name?: string; type?: string } | null;
	team?: { id?: string; key?: string; name?: string } | null;
	cycle?: { id?: string; name?: string; startsAt?: string; endsAt?: string } | null;
	[key: string]: unknown;
}

export interface LinearGraphqlClient {
	query<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface LinearSourceOptions extends SourceAdapterOptions {
	client: LinearGraphqlClient;
	pageSize?: number;
	repositoryMappings?: Record<string, string>;
}

interface LinearPage {
	issues: {
		nodes: LinearIssue[];
		pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
	};
}

const CURRENT_CYCLE_QUERY = `query BackgroundAgentsActiveCycleIssues($after: String, $first: Int!) {
  issues(
    filter: {
      assignee: { isMe: { eq: true } }
      cycle: { isActive: { eq: true } }
    }
    first: $first
    after: $after
  ) {
    nodes {
      id identifier title description url updatedAt
      state { id name type }
      team { id key name }
      cycle { id name startsAt endsAt }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

function unwrapPage(value: unknown): LinearPage {
	const record = value as { data?: LinearPage };
	return (record.data ?? value) as LinearPage;
}

function issueRevision(issue: LinearIssue): string {
	return issue.updatedAt ?? fingerprint(issue);
}

/**
 * Resolve mappings only from fields selected by CURRENT_CYCLE_QUERY. Explicit issue
 * identifiers take precedence over team id, then team key. Prefixes avoid collisions
 * between identifiers and team keys while retaining the convenient unprefixed form.
 */
export function linearRepositoryForIssue(
	issue: Pick<LinearIssue, "identifier" | "team">,
	mappings: Record<string, string> = {},
): string | undefined {
	const candidates = [
		`issue:${issue.identifier}`,
		issue.identifier,
		...(issue.team?.id ? [`team-id:${issue.team.id}`, issue.team.id] : []),
		...(issue.team?.key ? [`team-key:${issue.team.key}`, issue.team.key] : []),
	];
	return candidates
		.map((key) => mappings[key])
		.find((value): value is string => typeof value === "string" && value.trim() !== "");
}

export class LinearSourceAdapter implements SourceAdapter {
	readonly source = "linear" as const;
	private readonly options: LinearSourceOptions;

	constructor(options: LinearSourceOptions) {
		this.options = options;
	}

	async poll(): Promise<SourceEventResult[]> {
		const results: SourceEventResult[] = [];
		let after: string | null = null;
		let endCursor: string | undefined;
		let pages = 0;
		let latestRevision: string | undefined;
		do {
			const page = unwrapPage(
				await this.options.client.query<LinearPage>(CURRENT_CYCLE_QUERY, {
					after,
					first: this.options.pageSize ?? 100,
				}),
			);
			if (!page.issues || !Array.isArray(page.issues.nodes))
				throw new Error("Linear response did not contain issues.nodes");
			for (const issue of page.issues.nodes) {
				if (!issue.id || !issue.identifier || !issue.title) continue;
				const revision = issueRevision(issue);
				latestRevision = !latestRevision || revision > latestRevision ? revision : latestRevision;
				results.push(
					persistSourceEvent(
						this.options,
						{
							source: "linear",
							sourceKey: `linear:${issue.id}`,
							revision,
							title: `${issue.identifier}: ${issue.title}`,
							body: issue.description ?? "",
							repository: linearRepositoryForIssue(issue, this.options.repositoryMappings),
							fingerprint: fingerprint({
								id: issue.id,
								revision,
								title: issue.title,
								description: issue.description ?? "",
							}),
							metadata: {
								identifier: issue.identifier,
								url: issue.url ?? undefined,
								state: issue.state ?? undefined,
								team: issue.team ?? undefined,
								cycle: issue.cycle ?? undefined,
							},
						},
						undefined,
					),
				);
			}
			endCursor = page.issues.pageInfo?.endCursor ?? undefined;
			const hasNextPage = page.issues.pageInfo?.hasNextPage === true;
			after = hasNextPage ? (endCursor ?? null) : null;
			pages += 1;
			if (hasNextPage && !after) throw new Error("Linear response requested a page without an end cursor");
			if (pages > 1_000) throw new Error("Linear pagination exceeded safety limit");
		} while (after !== null);

		const cursor = JSON.stringify({
			endCursor,
			observedAt: this.options.now?.().toISOString() ?? new Date().toISOString(),
		});
		if (this.options.store.setSourceCursor) this.options.store.setSourceCursor("linear", cursor, latestRevision);
		return results;
	}
}

export { CURRENT_CYCLE_QUERY };
