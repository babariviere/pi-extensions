import type { BackgroundSource, CaseAction, Classification, RolloutMode } from "./types.ts";

export const BACKGROUND_AGENTS_PROTOCOL_VERSION = 1 as const;
export const BACKGROUND_AGENTS_PROTOCOL = "background-agents.v1" as const;

export type BackgroundRequest =
	| { version: 1; id: string; type: "dashboard.get" }
	| {
			version: 1;
			id: string;
			type: "case.submit";
			source: "manual";
			title: string;
			body: string;
			sourceKey?: string;
			repository?: string;
	  }
	| { version: 1; id: string; type: "case.action"; caseId: string; action: CaseAction; comment?: string }
	| { version: 1; id: string; type: "spec.feedback"; caseId: string; feedback: string }
	| { version: 1; id: string; type: "spec.approve"; caseId: string; specVersion: number; permissions: string[] }
	| { version: 1; id: string; type: "work-item.approve"; caseId: string; workItemId: string; specVersion: number }
	| {
			version: 1;
			id: string;
			type: "classifier.correct";
			caseId: string;
			classification: Classification;
	  }
	| {
			version: 1;
			id: string;
			type: "rollout.set";
			scope: "global" | "source" | "repository";
			value: RolloutMode;
			source?: BackgroundSource;
			repository?: string;
	  }
	| { version: 1; id: string; type: "emergency.stop"; enabled: boolean }
	| { version: 1; id: string; type: "pane.focus"; paneId: string }
	| { version: 1; id: string; type: "evidence.reproduce"; caseId: string; manifestId: string };

export type BackgroundResponse =
	| { version: 1; id: string; ok: true; result: unknown }
	| { version: 1; id: string; ok: false; error: { code: string; message: string } };

const SOURCES = new Set<BackgroundSource>(["manual", "slack", "linear", "datadog"]);
const ACTIONS = new Set<CaseAction>([
	"approve-specification",
	"approve-quick-fix",
	"request-changes",
	"resume",
	"reclassify",
	"cancel",
	"mark-handled",
	"reject",
]);
const KINDS = new Set(["error", "bug-report", "feature", "question", "maintenance", "other", "unknown"]);
const DISPOSITIONS = new Set(["actionable", "noise", "ambiguous"]);
const MODES = new Set<RolloutMode>(["observe", "supervised", "autonomous-pr"]);

function text(value: unknown, field: string): string | undefined {
	return typeof value === "string" && value.trim() ? undefined : `${field} must be a non-empty string`;
}

function requiredFields(request: Record<string, unknown>, fields: readonly string[]): string | undefined {
	for (const field of fields) {
		const error = text(request[field], field);
		if (error) return error;
	}
	return undefined;
}

/** Validate the complete wire contract after the socket has applied its byte limit. */
export function validateBackgroundRequest(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "request must be an object";
	const request = value as Record<string, unknown>;
	if (request.version !== BACKGROUND_AGENTS_PROTOCOL_VERSION) return "unsupported protocol version";
	const idError = text(request.id, "id");
	if (idError) return idError;
	if (typeof request.type !== "string") return "type must be a string";
	switch (request.type) {
		case "dashboard.get":
			return undefined;
		case "case.submit":
			if (request.source !== "manual") return "case.submit source must be manual";
			return requiredFields(request, ["title", "body"]);
		case "case.action":
			if (requiredFields(request, ["caseId"])) return requiredFields(request, ["caseId"]);
			return typeof request.action === "string" && ACTIONS.has(request.action as CaseAction)
				? undefined
				: "case.action action is invalid";
		case "spec.feedback":
			return requiredFields(request, ["caseId", "feedback"]);
		case "spec.approve":
			if (requiredFields(request, ["caseId"])) return requiredFields(request, ["caseId"]);
			if (!Number.isSafeInteger(request.specVersion) || Number(request.specVersion) <= 0)
				return "specVersion must be a positive integer";
			return Array.isArray(request.permissions) &&
				request.permissions.every((item) => text(item, "permission") === undefined)
				? undefined
				: "permissions must be an array of non-empty strings";
		case "work-item.approve":
			if (requiredFields(request, ["caseId", "workItemId"]))
				return requiredFields(request, ["caseId", "workItemId"]);
			return Number.isSafeInteger(request.specVersion) && Number(request.specVersion) > 0
				? undefined
				: "specVersion must be a positive integer";
		case "classifier.correct": {
			if (requiredFields(request, ["caseId"])) return requiredFields(request, ["caseId"]);
			if (!request.classification || typeof request.classification !== "object")
				return "classification must be an object";
			const classification = request.classification as Record<string, unknown>;
			if (typeof classification.inputKind !== "string" || !KINDS.has(classification.inputKind))
				return "classification inputKind is invalid";
			if (typeof classification.disposition !== "string" || !DISPOSITIONS.has(classification.disposition))
				return "classification disposition is invalid";
			return undefined;
		}
		case "rollout.set":
			if (request.scope !== "global" && request.scope !== "source" && request.scope !== "repository")
				return "rollout scope is invalid";
			if (!MODES.has(request.value as RolloutMode)) return "rollout value is invalid";
			if (request.scope === "source" && !SOURCES.has(request.source as BackgroundSource))
				return "rollout source is required";
			if (request.scope === "repository" && text(request.repository, "repository")) return "repository is required";
			return undefined;
		case "emergency.stop":
			return typeof request.enabled === "boolean" ? undefined : "emergency stop enabled must be boolean";
		case "pane.focus":
			return requiredFields(request, ["paneId"]);
		case "evidence.reproduce":
			return requiredFields(request, ["caseId", "manifestId"]);
		default:
			return "request type is invalid";
	}
}

export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
	return validateBackgroundRequest(value) === undefined;
}

export function encodeBackgroundMessage(message: BackgroundRequest | BackgroundResponse): string {
	return `${JSON.stringify(message)}\n`;
}
