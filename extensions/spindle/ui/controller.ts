/**
 * LOCAL REWRITE of upstream `src/ui/controller.ts`.
 *
 * Keeps the polling/refresh shape (`start`/`stop`/`#schedulePoll`/
 * `#scheduleRefresh`/`#refresh`/`#renderWidget`) and the single
 * `aboveEditor` widget. Everything else — `openDashboard`, the model picker,
 * mesh event polling, actor subscriptions and the transcript sources — belongs
 * to dropped subsystems and is gone.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { CodePreviewSettings } from "./code-preview.ts";
import type { SpindleActivityRun } from "../activity/types.ts";
import type { SpindleState } from "../spindle-state.ts";
import { createDashboardSnapshot } from "./snapshot.ts";
import { isActiveStatus, type SpindleDashboardSnapshot } from "./types.ts";
import { SpindleWidget, shouldShowSpindleWidget } from "./widget.ts";

const WIDGET_ID = "spindle";
const ACTIVITY_REFRESH_MS = 100;

const emptySnapshot = (): SpindleDashboardSnapshot => ({
  now: Date.now(),
  runs: [],
  agents: [],
  actors: [],
});

export class SpindleUiController {
  #context: ExtensionContext | undefined;
  #snapshot: SpindleDashboardSnapshot = emptySnapshot();
  #timer: NodeJS.Timeout | undefined;
  #activityUnsubscribe: (() => void) | undefined;
  #agentUnsubscribe: (() => void) | undefined;
  #scheduledRefresh: NodeJS.Timeout | undefined;
  #widgetTui: TUI | undefined;
  #widgetMounted = false;
  #widget: SpindleWidget | undefined;
  #lastRefreshErrorAt = 0;
  #lastRefreshAt = 0;
  #activityRevision: number | undefined;
  #activityRuns: SpindleActivityRun[] = [];

  constructor(
    readonly state: SpindleState,
    readonly codePreviewSettings?: CodePreviewSettings,
  ) {}

  start(context: ExtensionContext): void {
    this.stop();
    this.#context = context;
    if (!this.state.config.ui.enabled || context.mode !== "tui") return;
    this.#activityUnsubscribe = this.state.activity.subscribe(() => this.#scheduleRefresh());
    this.#agentUnsubscribe = this.state.agentRuns.subscribe(() => this.#scheduleRefresh());
    this.#refresh();
    this.#schedulePoll();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#scheduledRefresh) clearTimeout(this.#scheduledRefresh);
    this.#timer = undefined;
    this.#scheduledRefresh = undefined;
    this.#widget = undefined;
    this.#activityUnsubscribe?.();
    this.#activityUnsubscribe = undefined;
    this.#agentUnsubscribe?.();
    this.#agentUnsubscribe = undefined;
    if (this.#context?.mode === "tui") {
      this.#context.ui.setWidget(WIDGET_ID, undefined);
    }
    this.#context = undefined;
    this.#widgetTui = undefined;
    this.#widgetMounted = false;
    this.#snapshot = emptySnapshot();
    this.#lastRefreshErrorAt = 0;
    this.#lastRefreshAt = 0;
    this.#activityRevision = undefined;
    this.#activityRuns = [];
  }

  snapshot(): SpindleDashboardSnapshot {
    return structuredClone(this.#snapshot);
  }

  #schedulePoll(reset = false): void {
    if (reset && this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#timer || !this.#context) return;
    const active =
      this.#snapshot.runs.some((run) => run.status === "running") ||
      this.#snapshot.agents.some((agent) => isActiveStatus(agent.status));
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
    const delay = Math.max(
      0,
      Math.min(ACTIVITY_REFRESH_MS, this.state.config.ui.refreshMs) - elapsed,
    );
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
      const revision =
        typeof this.state.activity.revision === "function"
          ? this.state.activity.revision()
          : undefined;
      if (revision === undefined || revision !== this.#activityRevision) {
        this.#activityRuns = this.state.activity.runs();
        this.#activityRevision = revision;
      }
      this.#snapshot = createDashboardSnapshot(this.state, context, this.#activityRuns);
      this.#renderWidget(context);
      if (this.#widgetTui && this.#widget?.hasChanged()) this.#widgetTui.requestRender();
    } catch (error) {
      const now = Date.now();
      if (now - this.#lastRefreshErrorAt >= 10_000) {
        this.#lastRefreshErrorAt = now;
        const message = error instanceof Error ? error.message : String(error);
        context.ui.notify(`Spindle widget refresh failed: ${message}`, "warning");
      }
    }
  }

  #renderWidget(context: ExtensionContext): void {
    const config = this.state.config.ui;
    const shouldShow =
      context.mode === "tui" && shouldShowSpindleWidget(this.#snapshot, config.widget);
    if (shouldShow) {
      if (this.#widgetMounted) return;
      this.#widgetMounted = true;
      context.ui.setWidget(
        WIDGET_ID,
        (tui, theme) => {
          this.#widgetTui = tui;
          this.#widget = new SpindleWidget(theme, () => this.#snapshot, config.maxRows);
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
