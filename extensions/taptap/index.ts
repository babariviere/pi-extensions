/**
 * taptap
 *
 * Requires a double tap on Escape before pi cancels anything.
 *
 * A single Escape is easy to hit by accident and immediately aborts the run.
 * This extension intercepts Escape in the editor, shows a footer hint on the
 * first tap, and only forwards to pi's own handler when a second tap lands
 * inside the window.
 *
 * Forwarding goes through `CustomEditor.onEscape`, which is the exact handler
 * pi installs for `app.interrupt`. That keeps every native behaviour intact:
 * restoring queued messages, aborting a running bash, leaving bash mode, the
 * `doubleEscapeAction` tree/fork picker, and the agent abort itself.
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

	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly keys: KeybindingsManager,
		private readonly hint: Hint,
	) {
		super(tui, theme, keys);
	}

	override handleInput(data: string): void {
		// Escape also closes the autocomplete popup; leave that on a single tap.
		if (!this.keys.matches(data, "app.interrupt") || this.isShowingAutocomplete()) {
			this.disarm();
			super.handleInput(data);
			return;
		}

		if (this.tracker.tap(Date.now()) === "arm") {
			this.hint.show();
			this.timer = setTimeout(() => this.disarm(), TAP_WINDOW_MS);
			return;
		}

		this.disarm();
		this.forwardToPi(data);
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

	private disarm(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (!this.tracker.armed) return;
		this.tracker.reset();
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
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new DoubleEscapeEditor(tui, theme, keybindings, hint),
		);
	});
}
