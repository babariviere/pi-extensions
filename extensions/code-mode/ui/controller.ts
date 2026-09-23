/**
 * LOCAL REWRITE of upstream `src/ui/controller.ts`.
 *
 * Keeps one above-editor widget for detached subagents and background jobs.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { CodePreviewSettings } from "./code-preview.ts";
import type { CodeModeState } from "../code-mode-state.ts";
import { createDashboardSnapshot } from "./snapshot.ts";
import { isActiveStatus, type CodeModeDashboardSnapshot } from "./types.ts";
import { CodeModeWidget, shouldShowCodeModeWidget } from "./widget.ts";

const WIDGET_ID = "code-mode";
const ACTIVITY_REFRESH_MS = 100;

const emptySnapshot = (): CodeModeDashboardSnapshot => ({
	now: Date.now(),
	agents: [],
	jobs: [],
});

export class CodeModeUiController {
	#context: ExtensionContext | undefined;
	#snapshot: CodeModeDashboardSnapshot = emptySnapshot();
	#timer: NodeJS.Timeout | undefined;
	#agentUnsubscribe: (() => void) | undefined;
	#scheduledRefresh: NodeJS.Timeout | undefined;
	#widgetTui: TUI | undefined;
	#widgetMounted = false;
	#widget: CodeModeWidget | undefined;
	#lastRefreshErrorAt = 0;
	#lastRefreshAt = 0;

	constructor(
		readonly state: CodeModeState,
		readonly codePreviewSettings?: CodePreviewSettings,
	) {}

	start(context: ExtensionContext): void {
		this.stop();
		this.#context = context;
		if (!this.state.config.ui.enabled || context.mode !== "tui") return;
		this.#agentUnsubscribe = this.state.agentRuns.subscribe(() => this.#scheduleRefresh());
		this.state.onJobsChange(() => this.#scheduleRefresh());
		this.#refresh();
		this.#schedulePoll();
	}

	stop(): void {
		if (this.#timer) clearTimeout(this.#timer);
		if (this.#scheduledRefresh) clearTimeout(this.#scheduledRefresh);
		this.#timer = undefined;
		this.#scheduledRefresh = undefined;
		this.#widget = undefined;
		this.#agentUnsubscribe?.();
		this.#agentUnsubscribe = undefined;
		this.state.onJobsChange(undefined);
		if (this.#context?.mode === "tui") {
			this.#context.ui.setWidget(WIDGET_ID, undefined);
		}
		this.#context = undefined;
		this.#widgetTui = undefined;
		this.#widgetMounted = false;
		this.#snapshot = emptySnapshot();
		this.#lastRefreshErrorAt = 0;
		this.#lastRefreshAt = 0;
	}

	snapshot(): CodeModeDashboardSnapshot {
		return structuredClone(this.#snapshot);
	}

	#schedulePoll(reset = false): void {
		if (reset && this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		if (this.#timer || !this.#context) return;
		const active =
			this.#snapshot.agents.some((agent) => isActiveStatus(agent.status)) || this.#snapshot.jobs.length > 0;
		if (!active) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#refresh();
			this.#schedulePoll();
		}, this.state.config.ui.refreshMs);
		this.#timer.unref();
	}

	#scheduleRefresh(): void {
		if (this.#scheduledRefresh || !this.#context) return;
		const elapsed = performance.now() - this.#lastRefreshAt;
		const delay = Math.max(0, Math.min(ACTIVITY_REFRESH_MS, this.state.config.ui.refreshMs) - elapsed);
		this.#scheduledRefresh = setTimeout(() => {
			this.#scheduledRefresh = undefined;
			this.#refresh();
			this.#schedulePoll(true);
		}, delay);
		this.#scheduledRefresh.unref();
	}

	#refresh(): void {
		this.#lastRefreshAt = performance.now();
		const context = this.#context;
		if (!context || !this.state.initialized) return;
		try {
			this.#snapshot = createDashboardSnapshot(this.state);
			this.#renderWidget(context);
			if (this.#widgetTui && this.#widget?.hasChanged()) this.#widgetTui.requestRender();
		} catch (error) {
			const now = Date.now();
			if (now - this.#lastRefreshErrorAt >= 10_000) {
				this.#lastRefreshErrorAt = now;
				const message = error instanceof Error ? error.message : String(error);
				context.ui.notify(`Code Mode widget refresh failed: ${message}`, "warning");
			}
		}
	}

	#renderWidget(context: ExtensionContext): void {
		const config = this.state.config.ui;
		const shouldShow = context.mode === "tui" && shouldShowCodeModeWidget(this.#snapshot, config.widget);
		if (shouldShow) {
			if (this.#widgetMounted) return;
			this.#widgetMounted = true;
			context.ui.setWidget(
				WIDGET_ID,
				(tui, theme) => {
					this.#widgetTui = tui;
					this.#widget = new CodeModeWidget(theme, () => this.#snapshot, config.maxRows);
					return this.#widget;
				},
				{ placement: "aboveEditor" },
			);
			return;
		}
		if (!this.#widgetMounted) return;
		context.ui.setWidget(WIDGET_ID, undefined);
		this.#widgetMounted = false;
		this.#widgetTui = undefined;
		this.#widget = undefined;
	}
}
