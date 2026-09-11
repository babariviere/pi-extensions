import type {
	BackgroundSource,
	CaseAction,
	Classification,
	DashboardSnapshot,
	EvidenceManifest,
	RolloutMode,
} from "./types.ts";

export const BACKGROUND_AGENTS_PROTOCOL_VERSION = 1 as const;
export const BACKGROUND_AGENTS_PROTOCOL = "background-agents.v1" as const;

export type BackgroundRequest =
	| { version: 1; id: string; type: "dashboard.get" }
	| { version: 1; id: string; type: "case.submit"; source: "manual"; title: string; body: string; repository?: string }
	| { version: 1; id: string; type: "case.action"; caseId: string; action: CaseAction; comment?: string }
	| { version: 1; id: string; type: "spec.feedback"; caseId: string; feedback: string }
	| { version: 1; id: string; type: "spec.approve"; caseId: string; specVersion: number; permissions: string[] }
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
	| { version: 1; id: string; type: "evidence.reproduce"; caseId: string; manifest: EvidenceManifest };

export type BackgroundResponse =
	| { version: 1; id: string; ok: true; result: DashboardSnapshot | { accepted: true; caseId?: string } }
	| { version: 1; id: string; ok: false; error: { code: string; message: string } };

export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const request = value as Record<string, unknown>;
	return (
		request.version === BACKGROUND_AGENTS_PROTOCOL_VERSION &&
		typeof request.id === "string" &&
		typeof request.type === "string"
	);
}

export function encodeBackgroundMessage(message: BackgroundRequest | BackgroundResponse): string {
	return `${JSON.stringify(message)}\n`;
}
