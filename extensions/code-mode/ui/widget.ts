import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodeModeUiWidgetMode } from "../config.ts";
import { spinnerFrame } from "./spinner.ts";
import { formatDuration, formatTokens, safeText } from "./format.ts";
import {
	isActiveStatus,
	orderAgentsByCreation,
	type CodeModeDashboardSnapshot,
	type CodeModeUiAgent,
} from "./types.ts";

const statusGlyph = (status: string): string => {
	if (status === "completed" || status === "done") return "✓";
	if (status === "failed" || status === "timed_out") return "✗";
	if (status === "blocked") return "!";
	if (status === "stopped" || status === "cancelled") return "■";
	if (status === "queued" || status === "pending" || status === "ready") return "○";
	if (status === "idle" || status === "state") return "·";
	return spinnerFrame();
};

const colorStatus = (theme: Theme, status: string, value: string): string => {
	if (status === "completed" || status === "done") return theme.fg("success", value);
	if (status === "failed" || status === "timed_out") return theme.fg("error", value);
	if (status === "blocked") return theme.fg("warning", value);
	if (status === "running" || status === "in_progress") return theme.fg("accent", value);
	return theme.fg("dim", value);
};

const agentLines = (theme: Theme, agent: CodeModeUiAgent, now: number): string[] => {
	const status = colorStatus(theme, agent.status, statusGlyph(agent.status));
	const activity =
		agent.currentTool ??
		(agent.error
			? `error: ${truncateToWidth(safeText(agent.error), 48)}`
			: agent.text && !isActiveStatus(agent.status)
				? `result: ${truncateToWidth(safeText(agent.text), 48)}`
				: agent.status === "running"
					? "thinking"
					: agent.status);
	const metrics = [
		agent.toolCalls !== undefined ? `${agent.toolCalls} calls` : undefined,
		agent.usage ? `${formatTokens(agent.usage.input + agent.usage.output)} tok` : undefined,
		agent.startedAt ? formatDuration((agent.finishedAt ?? now) - agent.startedAt) : undefined,
	].filter((value): value is string => Boolean(value));
	const indent = "  ".repeat(1 + Math.max(0, agent.nestingDepth ?? 0));
	return [
		`${indent}${status} ${safeText(agent.name)}  ${theme.fg("muted", safeText(activity))}${
			metrics.length > 0 ? theme.fg("dim", ` · ${metrics.join(" · ")}`) : ""
		}`,
	];
};

export const shouldShowCodeModeWidget = (snapshot: CodeModeDashboardSnapshot, mode: CodeModeUiWidgetMode): boolean => {
	if (mode === "hidden") return false;
	if (mode === "always") return true;
	return snapshot.jobs.length > 0 || snapshot.agents.some((agent) => isActiveStatus(agent.status));
};

export class CodeModeWidget implements Component {
	constructor(
		readonly theme: Theme,
		readonly snapshot: () => CodeModeDashboardSnapshot,
		readonly maxRows: number,
	) {}

	#lastWidth: number | undefined;
	#lastSnapshot: CodeModeDashboardSnapshot | undefined;
	#lastLines: string[] | undefined;
	#leaseKey: string | undefined;
	#leasedRows = 0;
	#pending: { width: number; snapshot: CodeModeDashboardSnapshot; lines: string[] } | undefined;

	render(width: number): string[] {
		if (width <= 0) return [];
		const snapshot = this.snapshot();
		const lines =
			this.#pending?.width === width && this.#pending.snapshot === snapshot
				? this.#pending.lines
				: this.#lastWidth === width && this.#lastSnapshot === snapshot && this.#lastLines
					? this.#lastLines
					: this.#renderLines(snapshot, width);
		this.#pending = undefined;
		this.#lastWidth = width;
		this.#lastSnapshot = snapshot;
		this.#lastLines = lines;
		return lines;
	}

	hasChanged(): boolean {
		if (this.#lastWidth === undefined || this.#lastLines === undefined) return true;
		const snapshot = this.snapshot();
		const lines = this.#renderLines(snapshot, this.#lastWidth);
		this.#pending = { width: this.#lastWidth, snapshot, lines };
		return lines.length !== this.#lastLines.length || lines.some((line, index) => line !== this.#lastLines?.[index]);
	}

	invalidate(): void {
		this.#pending = undefined;
		this.#lastWidth = undefined;
		this.#lastSnapshot = undefined;
		this.#lastLines = undefined;
	}

	#renderLines(snapshot: CodeModeDashboardSnapshot, width: number): string[] {
		const { lines: content, leaseKey } = this.#buildContent(snapshot);
		return this.#leaseContent(this.#boundContent(content, width), leaseKey);
	}

	#buildContent(snapshot: CodeModeDashboardSnapshot): { lines: string[]; leaseKey: string } {
		const activeAgents = orderAgentsByCreation(snapshot.agents).filter((agent) => isActiveStatus(agent.status));
		const activeJobs = snapshot.jobs;
		const headerStatus = activeJobs.length > 0 || activeAgents.length > 0 ? "running" : "idle";
		const parts: string[] = [];
		if (activeAgents.length > 0) parts.push(`${activeAgents.length} agent${activeAgents.length === 1 ? "" : "s"}`);
		if (activeJobs.length > 0) parts.push(`${activeJobs.length} job${activeJobs.length === 1 ? "" : "s"}`);

		const glyph = colorStatus(this.theme, headerStatus, statusGlyph(headerStatus));
		const header = `${glyph} ${this.theme.fg("accent", "Code Mode")} ${this.theme.fg("text", "background work")}${parts.length > 0 ? this.theme.fg("dim", ` · ${parts.join(" · ")}`) : ""}`;
		const lines = [header];

		lines.push(
			...activeJobs.map(
				(job) =>
					`  ${colorStatus(this.theme, "running", statusGlyph("running"))} ${safeText(job.name)}  ${this.theme.fg("muted", `job ${job.id.slice(0, 8)}`)}${this.theme.fg("dim", ` · ${formatDuration(snapshot.now - job.startedAt)}`)}`,
			),
			...activeAgents.flatMap((agent) => agentLines(this.theme, agent, snapshot.now)),
		);
		const ambientOwners = [
			...activeAgents.map((agent) => `agent:${agent.id}`),
			...activeJobs.map((job) => `job:${job.id}`),
		];
		return {
			lines,
			leaseKey: ambientOwners.length > 0 ? `ambient:${ambientOwners.join(",")}` : "ambient",
		};
	}

	#leaseContent(lines: string[], leaseKey: string): string[] {
		if (this.#leaseKey !== leaseKey) {
			this.#leaseKey = leaseKey;
			this.#leasedRows = lines.length;
		} else {
			this.#leasedRows = Math.max(this.#leasedRows, lines.length);
		}
		if (lines.length >= this.#leasedRows) return lines;
		return [...lines, ...Array.from({ length: this.#leasedRows - lines.length }, () => "")];
	}

	#boundContent(content: string[], width: number): string[] {
		const bounded = content.slice(0, Math.max(1, this.maxRows));
		if (content.length > bounded.length && bounded.length > 0) {
			const marker = this.theme.fg("dim", `+${content.length - bounded.length}`);
			const available = Math.max(0, width - visibleWidth(marker) - 1);
			const last = truncateToWidth(bounded[bounded.length - 1] ?? "", available, "");
			bounded[bounded.length - 1] = `${last} ${marker}`;
		}
		return bounded.map((line) => truncateToWidth(line, width));
	}
}
