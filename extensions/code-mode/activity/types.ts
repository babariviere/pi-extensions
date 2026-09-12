type SpindleRunStatus = "running" | "completed" | "failed" | "cancelled";
export type SpindleActivityStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "stopped";

export type SpindleActivityKind = "agent" | "actor" | "tool" | "extension" | "mcp" | "mesh" | "task" | "custom";

export interface SpindleRunDisplay {
	name?: string;
	description?: string;
}

export interface SpindlePhaseInput {
	name: string;
	id?: string;
	description?: string;
	total?: number;
}

export interface SpindleActivityItemInput {
	id: string;
	label: string;
	status?: SpindleActivityStatus;
	phase?: string;
	detail?: string;
	kind?: SpindleActivityKind;
	current?: string;
	total?: number;
	completed?: number;
	data?: unknown;
}

export interface SpindleActivityEventInput {
	message: string;
	level?: "info" | "success" | "warning" | "error";
	data?: unknown;
}

export interface SpindleActivityPhase {
	id: string;
	name: string;
	description?: string;
	status: SpindleActivityStatus;
	total?: number;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
}

export interface SpindleActivityMetrics {
	tokens?: number;
	toolCalls?: number;
	cost?: number;
}

export interface SpindleActivityCall {
	id: string;
	ref: string;
	label: string;
	kind: SpindleActivityKind;
	status: SpindleActivityStatus;
	phaseId?: string;
	entityId?: string;
	entityKind?: SpindleActivityKind;
	args?: Record<string, unknown>;
	result?: unknown;
	preview?: unknown;
	progress?: string;
	error?: string;
	detail?: string;
	metrics?: SpindleActivityMetrics;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
}

export interface SpindleActivityItem {
	id: string;
	label: string;
	status: SpindleActivityStatus;
	kind: SpindleActivityKind;
	phaseId?: string;
	detail?: string;
	current?: string;
	total?: number;
	completed?: number;
	data?: unknown;
	createdAt: number;
	updatedAt: number;
	finishedAt?: number;
}

interface SpindleActivityEvent {
	id: string;
	message: string;
	level: "info" | "success" | "warning" | "error";
	data?: unknown;
	createdAt: number;
}

export interface SpindleActivityRun {
	id: string;
	name: string;
	description?: string;
	status: SpindleRunStatus;
	phases: SpindleActivityPhase[];
	calls: SpindleActivityCall[];
	items: SpindleActivityItem[];
	events: SpindleActivityEvent[];
	currentPhaseId?: string;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
	error?: string;
}
