/**
 * taptap
 *
 * Requires a double tap on Escape before pi cancels a running agent turn.
 *
 * A single Escape is easy to hit by accident and immediately aborts the run.
 * This extension intercepts Escape in the editor while the agent is busy, shows
 * a footer hint on the first tap, and only forwards to pi's own handler when a
 * second tap lands inside the window.
 *
 * While the agent is idle there is nothing to abort, so Escape is passed
 * straight through. That keeps pi's own double-Escape flow (the tree/fork
 * history picker on an empty editor) reachable with two taps instead of four.
 *
 * Forwarding goes through `CustomEditor.onEscape`, which is the exact handler
 * pi installs for `app.interrupt`. That keeps every native behaviour intact:
 * restoring queued messages, aborting a running bash, leaving bash mode, and
 * the agent abort itself.
 *
 * Escape is left alone while the autocomplete popup is open, so it still
 * cancels completion on the first tap.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { TapTracker } from "./tap-tracker.ts";

/** How long the first tap stays armed. */
const TAP_WINDOW_MS = 600;

/** Footer status key, also used to clear the hint. */
const STATUS_KEY = "taptap";

const HINT = "esc again to cancel";

interface Hint {
	show(): void;
	clear(): void;
}

class DoubleEscapeEditor extends CustomEditor {
	private readonly tracker = new TapTracker(TAP_WINDOW_MS);
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** Whether the footer hint is currently shown. */
	private hinted = false;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly keys: KeybindingsManager,
		private readonly hint: Hint,
		private readonly isIdle: () => boolean,
	) {
		super(tui, theme, keys);
	}

	override handleInput(data: string): void {
		if (!this.shouldGuard(data)) {
			this.disarm();
			super.handleInput(data);
			return;
		}

		if (this.tracker.tap(Date.now()) === "arm") {
			this.hinted = true;
			this.hint.show();
			this.timer = setTimeout(() => this.disarm(), TAP_WINDOW_MS);
			return;
		}

		this.disarm();
		this.forwardToPi(data);
	}

	/**
	 * Whether this key press should be swallowed until a second tap.
	 *
	 * Only Escape while the agent is streaming. Escape also closes the
	 * autocomplete popup, and while idle it drives pi's own double-Escape
	 * history picker, so both cases go through untouched.
	 */
	private shouldGuard(data: string): boolean {
		if (!this.keys.matches(data, "app.interrupt")) return false;
		if (this.isShowingAutocomplete()) return false;
		return !this.isIdle();
	}

	/**
	 * Run pi's own `app.interrupt` handler.
	 *
	 * `onEscape` is reassigned by pi in some flows (branch summary, for example),
	 * so it is read at call time rather than captured. When neither handler is
	 * installed, fall back to the base dispatch.
	 */
	private forwardToPi(data: string): void {
		const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
		if (handler) {
			handler();
			return;
		}
		super.handleInput(data);
	}

	/**
	 * Drop the armed tap and the footer hint.
	 *
	 * The hint is tracked separately from `tracker.armed`: a firing tap already
	 * clears the tracker, so keying off it would leave the hint on screen after
	 * a completed double tap.
	 */
	private disarm(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.tracker.reset();
		if (!this.hinted) return;
		this.hinted = false;
		this.hint.clear();
	}
}

function makeHint(ctx: ExtensionContext): Hint {
	return {
		show: () => ctx.ui.setStatus(STATUS_KEY, HINT),
		clear: () => ctx.ui.setStatus(STATUS_KEY, undefined),
	};
}

export default function taptap(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const hint = makeHint(ctx);
		const isIdle = () => ctx.isIdle();
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new DoubleEscapeEditor(tui, theme, keybindings, hint, isIdle),
		);
	});
}
