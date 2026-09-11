import type { BackgroundAgentsDatabase } from "../database.ts";
import type { CaseState, SourceEvent } from "../../types.ts";
import { retrieveRelatedCases, sourceMemoryQuery, type RelatedCaseSummary } from "../classification/memory.ts";

const MAX_EVIDENCE_EVENTS = 20;
const MAX_EVENT_BODY = 16_384;

export interface InvestigationOutput {
	autonomy: "quick-fix-candidate" | "spec-required" | "needs-human";
	findings: string;
	rootCause?: string;
	scope?: string;
	risks?: string[];
	verificationPlan?: string[];
	confidence: number;
	uncertainties: string[];
	sources?: string[];
}

export interface InvestigationContext {
	mode: "investigation";
	case: { id: string; title: string; state: CaseState; repository?: string };
	currentEvidence: SourceEvent[];
	relatedCases: RelatedCaseSummary[];
	capabilities: { tools: string[]; fullCaseRetrieval: "explicit" };
}

export interface FullCase {
	case: Record<string, unknown>;
	events: Array<Record<string, unknown>>;
	classifications: Array<Record<string, unknown>>;
	relations: Array<Record<string, unknown>>;
}

function requiredCase(database: BackgroundAgentsDatabase, caseId: string): InvestigationContext["case"] {
	const row = database.get<Record<string, unknown>>(
		"SELECT id, title, state, repository FROM cases WHERE id = ?",
		caseId,
	);
	if (!row) throw new Error(`Unknown case: ${caseId}`);
	return {
		id: String(row.id),
		title: String(row.title),
		state: String(row.state) as CaseState,
		...(row.repository == null ? {} : { repository: String(row.repository) }),
	};
}

function parseMetadata(value: unknown): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(String(value));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function currentEvidence(database: BackgroundAgentsDatabase, caseId: string): SourceEvent[] {
	return database
		.all<Record<string, unknown>>(
			"SELECT source, source_key, revision, received_at, title, body, fingerprint, repository, service, metadata FROM source_events WHERE case_id = ? ORDER BY received_at DESC, created_at DESC LIMIT ?",
			caseId,
			MAX_EVIDENCE_EVENTS,
		)
		.map((row) => ({
			source: String(row.source) as SourceEvent["source"],
			sourceKey: String(row.source_key),
			...(row.revision ? { revision: String(row.revision) } : {}),
			receivedAt: String(row.received_at),
			title: String(row.title),
			body: String(row.body).slice(0, MAX_EVENT_BODY),
			...(row.fingerprint == null ? {} : { fingerprint: String(row.fingerprint) }),
			...(row.repository == null ? {} : { repository: String(row.repository) }),
			...(row.service == null ? {} : { service: String(row.service) }),
			metadata: parseMetadata(row.metadata),
		}));
}

/** Build bounded investigator input. Prior cases are summaries, never instructions. */
export function buildInvestigationContext(
	database: BackgroundAgentsDatabase,
	caseId: string,
	limit = 8,
): InvestigationContext {
	const currentCase = requiredCase(database, caseId);
	const evidence = currentEvidence(database, caseId);
	const query = evidence[0] ? sourceMemoryQuery(evidence[0]) : { caseId, text: currentCase.title };
	return {
		mode: "investigation",
		case: currentCase,
		currentEvidence: evidence,
		relatedCases: retrieveRelatedCases(database, { ...query, caseId, limit }),
		capabilities: { tools: ["read", "grep", "find", "ls"], fullCaseRetrieval: "explicit" },
	};
}

/** Full prior-case access is a separate explicit operation and is never included in the bounded context. */
export function retrieveFullCase(database: BackgroundAgentsDatabase, caseId: string): FullCase {
	requiredCase(database, caseId);
	const read = (sql: string): Array<Record<string, unknown>> => database.all<Record<string, unknown>>(sql, caseId);
	return {
		case: database.get<Record<string, unknown>>("SELECT * FROM cases WHERE id = ?", caseId) ?? {},
		events: read("SELECT * FROM source_events WHERE case_id = ? ORDER BY created_at ASC"),
		classifications: read("SELECT * FROM classifications WHERE case_id = ? ORDER BY created_at ASC"),
		relations: read("SELECT * FROM case_relations WHERE case_id = ? ORDER BY created_at ASC"),
	};
}

export class InvestigationWorkflow {
	constructor(private readonly database: BackgroundAgentsDatabase) {}

	start(caseId: string, priority = 0): { jobId: string; context: InvestigationContext } {
		const current = requiredCase(this.database, caseId);
		if (current.state === "classified" || current.state === "retry") {
			this.database.transitionCase(caseId, "investigating", "workflow", "investigation started");
		} else if (current.state !== "investigating") {
			throw new Error(`Case ${caseId} cannot start investigation from ${current.state}`);
		}
		const existing = this.database.get<{ id: string }>(
			"SELECT id FROM jobs WHERE case_id = ? AND role = 'investigator' AND state IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
			caseId,
		);
		const jobId = existing?.id ?? this.database.createJob({ caseId, role: "investigator", priority });
		return { jobId, context: buildInvestigationContext(this.database, caseId) };
	}

	record(caseId: string, output: InvestigationOutput, attemptId?: string): string {
		if (!Number.isFinite(output.confidence) || output.confidence < 0 || output.confidence > 100)
			throw new Error("confidence must be between 0 and 100");
		const context = buildInvestigationContext(this.database, caseId);
		return this.database.createInvestigationReport({
			caseId,
			attemptId,
			evidence: context.currentEvidence,
			relatedCases: context.relatedCases,
			report: output,
		});
	}
}

export const createInvestigationWorkflow = (database: BackgroundAgentsDatabase): InvestigationWorkflow =>
	new InvestigationWorkflow(database);
