type CodeModeRunStatus = "running" | "completed" | "failed" | "cancelled";
export type CodeModeActivityStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "stopped";

export type CodeModeActivityKind = "agent" | "actor" | "tool" | "extension" | "mcp" | "mesh" | "task" | "custom";

export interface CodeModeRunDisplay {
	name?: string;
	description?: string;
}

export interface CodeModePhaseInput {
	name: string;
	id?: string;
	description?: string;
	total?: number;
}

export interface CodeModeActivityItemInput {
	id: string;
	label: string;
	status?: CodeModeActivityStatus;
	phase?: string;
	detail?: string;
	kind?: CodeModeActivityKind;
	current?: string;
	total?: number;
	completed?: number;
	data?: unknown;
}

export interface CodeModeActivityEventInput {
	message: string;
	level?: "info" | "success" | "warning" | "error";
	data?: unknown;
}

export interface CodeModeActivityPhase {
	id: string;
	name: string;
	description?: string;
	status: CodeModeActivityStatus;
	total?: number;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
}

export interface CodeModeActivityMetrics {
	tokens?: number;
	toolCalls?: number;
	cost?: number;
}

export interface CodeModeActivityCall {
	id: string;
	ref: string;
	label: string;
	kind: CodeModeActivityKind;
	status: CodeModeActivityStatus;
	phaseId?: string;
	entityId?: string;
	entityKind?: CodeModeActivityKind;
	args?: Record<string, unknown>;
	result?: unknown;
	preview?: unknown;
	progress?: string;
	error?: string;
	detail?: string;
	metrics?: CodeModeActivityMetrics;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
}

export interface CodeModeActivityItem {
	id: string;
	label: string;
	status: CodeModeActivityStatus;
	kind: CodeModeActivityKind;
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

interface CodeModeActivityEvent {
	id: string;
	message: string;
	level: "info" | "success" | "warning" | "error";
	data?: unknown;
	createdAt: number;
}

export interface CodeModeActivityRun {
	id: string;
	name: string;
	description?: string;
	status: CodeModeRunStatus;
	phases: CodeModeActivityPhase[];
	calls: CodeModeActivityCall[];
	items: CodeModeActivityItem[];
	events: CodeModeActivityEvent[];
	currentPhaseId?: string;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
	error?: string;
}
