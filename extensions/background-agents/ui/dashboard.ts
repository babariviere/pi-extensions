import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, Text, type Component, type TUI, matchesKey } from "@earendil-works/pi-tui";
import type { BackgroundSource, CaseAction, DashboardSnapshot, RolloutMode } from "../types.ts";
import { buildDashboardViewLines, DASHBOARD_VIEWS, nextDashboardView, type DashboardView } from "./views.ts";

export interface DashboardClient {
	getDashboard(): Promise<DashboardSnapshot>;
	action(caseId: string, action: CaseAction): Promise<unknown>;
	reproduce(caseId: string, manifestId: string): Promise<unknown>;
	setRollout?(value: RolloutMode, source?: BackgroundSource, repository?: string): Promise<unknown>;
	setEmergencyStop?(enabled: boolean): Promise<unknown>;
}

export interface DashboardOptions {
	client: DashboardClient;
	initialView?: DashboardView;
	initialSnapshot?: DashboardSnapshot;
	initialCaseId?: string;
	onError?: (message: string) => void;
}

const EMPTY_SNAPSHOT: DashboardSnapshot = {
	cases: [],
	attempts: [],
	profiles: [],
	workItems: [],
	stacks: [],
	classifications: [],
	policies: [],
	memory: [],
	specifications: [],
	approvals: [],
	feedback: [],
	questionBriefs: [],
	artifacts: [],
	jobs: [],
	usage: [],
	evidenceManifests: [],
	verificationRuns: [],
	system: {
		started: false,
		activeAttempts: 0,
		queuedJobs: 0,
		controller: "connected",
		socketMode: 0,
		socketMaxRequestBytes: 0,
	},
	rollout: "observe",
	emergencyStop: false,
	generatedAt: "",
};

/** Keyboard-only dashboard component. It owns no controller state and can be dismissed cleanly. */
export class BackgroundDashboard implements Component {
	private snapshot: DashboardSnapshot;
	private view: DashboardView;
	private selectedCaseIndex = 0;
	private selectedAttemptIndex = 0;
	private loading: boolean;
	private errorMessage: string | undefined;
	private readonly container: Container;
	private readonly body: Text;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (value: undefined) => void,
		private readonly options: DashboardOptions,
	) {
		this.snapshot = options.initialSnapshot ?? EMPTY_SNAPSHOT;
		this.loading = options.initialSnapshot === undefined;
		this.view = options.initialView ?? "case";
		if (options.initialCaseId) {
			const index = this.snapshot.cases.findIndex((item) => item.id === options.initialCaseId);
			if (index >= 0) this.selectedCaseIndex = index;
		}
		this.body = new Text("", 1, 0);
		this.container = new Container();
		this.container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.container.addChild(this.body);
		this.container.addChild(
			new Text(theme.fg("dim", "tab/shift-tab views  j/k select  r refresh  R reproduce  esc close"), 1, 0),
		);
		this.container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		if (options.initialSnapshot === undefined) void this.refresh();
	}

	render(width: number): string[] {
		const lines = buildDashboardViewLines(
			this.snapshot,
			this.view,
			this.selectedCaseIndex,
			this.selectedAttemptIndex,
		);
		const status = this.loading
			? this.theme.fg("muted", "Refreshing controller…")
			: this.errorMessage
				? this.theme.fg("warning", `Controller outage: ${this.errorMessage}`)
				: this.theme.fg("success", `Connected ${this.snapshot.generatedAt}`);
		this.body.setText(
			[
				this.theme.fg("accent", this.theme.bold("Background agents")),
				status,
				...lines.map((line) => this.theme.fg("text", line)),
			].join("\n"),
		);
		return this.container.render(width);
	}

	invalidate(): void {
		this.container.invalidate();
	}

	handleInput(data: string): void {
		if (data === "escape" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.view = nextDashboardView(this.view);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.view = nextDashboardView(this.view, -1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.moveSelection(-1);
			return;
		}
		if (data === "r") {
			void this.refresh();
			return;
		}
		if (data === "R") {
			void this.reproduce();
			return;
		}
		if (data === "A") {
			void this.caseAction("approve-specification");
			return;
		}
		if (data === "f") {
			void this.caseAction("request-changes");
			return;
		}
		if (data === "c") {
			void this.caseAction("reclassify");
			return;
		}
		if (data === "h") {
			void this.caseAction("mark-handled");
			return;
		}
		if (data === "n") {
			void this.caseAction("reject");
			return;
		}
		if (data === "x" || data === "X") {
			void this.caseAction("cancel");
			return;
		}
		if (matchesKey(data, Key.enter)) {
			void this.caseAction("resume");
			return;
		}
		if (
			(this.view === "rollout" && (data === "o" || data === "s" || data === "p")) ||
			(this.view === "system" && data === "e")
		) {
			void this.systemAction(data);
			return;
		}
		const viewIndex = Number(data) - 1;
		if (Number.isInteger(viewIndex) && viewIndex >= 0 && viewIndex < DASHBOARD_VIEWS.length) {
			this.view = DASHBOARD_VIEWS[viewIndex] ?? this.view;
			this.tui.requestRender();
		}
	}

	get currentView(): DashboardView {
		return this.view;
	}

	get currentSnapshot(): DashboardSnapshot {
		return this.snapshot;
	}

	async refresh(): Promise<void> {
		this.loading = true;
		this.errorMessage = undefined;
		this.tui.requestRender();
		try {
			this.snapshot = await this.options.client.getDashboard();
			if (this.options.initialCaseId) {
				const index = this.snapshot.cases.findIndex((item) => item.id === this.options.initialCaseId);
				if (index >= 0) this.selectedCaseIndex = index;
			}
			this.selectedCaseIndex = Math.min(this.selectedCaseIndex, Math.max(this.snapshot.cases.length - 1, 0));
			this.selectedAttemptIndex = Math.min(
				this.selectedAttemptIndex,
				Math.max(this.snapshot.attempts.length - 1, 0),
			);
		} catch (error) {
			this.errorMessage = error instanceof Error ? error.message : String(error);
			this.options.onError?.(this.errorMessage);
		} finally {
			this.loading = false;
			this.tui.requestRender();
		}
	}

	private moveSelection(amount: number): void {
		if (this.view === "attempt") {
			this.selectedAttemptIndex = Math.max(
				0,
				Math.min(this.snapshot.attempts.length - 1, this.selectedAttemptIndex + amount),
			);
		} else {
			this.selectedCaseIndex = Math.max(
				0,
				Math.min(this.snapshot.cases.length - 1, this.selectedCaseIndex + amount),
			);
		}
		this.tui.requestRender();
	}

	private selectedCaseId(): string | undefined {
		return this.snapshot.cases[this.selectedCaseIndex]?.id ?? this.snapshot.cases[0]?.id;
	}

	private async caseAction(action: CaseAction): Promise<void> {
		const caseId = this.selectedCaseId();
		if (!caseId) return;
		try {
			await this.options.client.action(caseId, action);
			await this.refresh();
		} catch (error) {
			this.errorMessage = error instanceof Error ? error.message : String(error);
			this.tui.requestRender();
		}
	}

	private async systemAction(data: string): Promise<void> {
		try {
			if (this.view === "system") {
				if (this.options.client.setEmergencyStop)
					await this.options.client.setEmergencyStop(!this.snapshot.emergencyStop);
			} else if (this.options.client.setRollout) {
				const value: RolloutMode = data === "o" ? "observe" : data === "s" ? "supervised" : "autonomous-pr";
				await this.options.client.setRollout(value);
			}
			await this.refresh();
		} catch (error) {
			this.errorMessage = error instanceof Error ? error.message : String(error);
			this.tui.requestRender();
		}
	}

	private async reproduce(): Promise<void> {
		const caseId = this.selectedCaseId();
		if (!caseId) return;
		const manifestId = this.snapshot.evidenceManifests.find((item) => item.caseId === caseId)?.id;
		if (!manifestId) {
			this.errorMessage = "No evidence manifest is available for the selected case";
			this.tui.requestRender();
			return;
		}
		try {
			await this.options.client.reproduce(caseId, manifestId);
			await this.refresh();
		} catch (error) {
			this.errorMessage = error instanceof Error ? error.message : String(error);
			this.tui.requestRender();
		}
	}
}

export async function openBackgroundDashboard(
	ctx: {
		ui: {
			custom<T>(
				factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (value: T) => void) => Component,
			): Promise<T>;
		};
	},
	client: DashboardClient,
	initialView?: DashboardView,
	initialCaseId?: string,
	initialSnapshot?: DashboardSnapshot,
): Promise<void> {
	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) =>
			new BackgroundDashboard(tui, theme, done, { client, initialView, initialCaseId, initialSnapshot }),
	);
}
