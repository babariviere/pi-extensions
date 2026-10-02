/** Displays the effective system prompt in a responsive, scrollable TUI view. */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Key, ScrollView, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, KeybindingsManager, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

const VIEWER_HELP = "↑/↓ scroll • PgUp/PgDn page • Home/End jump • Enter/Esc close";

class PromptViewer implements Component {
	private readonly body: Text;
	private readonly header: Text;
	private readonly footer: Text;
	private readonly scrollView: ScrollView;
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly keybindings: KeybindingsManager;
	private readonly onDone: () => void;
	private readonly logicalLines: string[];
	private readonly numberWidth: number;

	constructor(prompt: string, tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: () => void) {
		const logicalLines = prompt.split("\n");
		const numberWidth = String(logicalLines.length).length;
		const header = new Text("", 0, 0);
		const body = new Text("", 0, 0);
		const scrollView = new ScrollView(body, {
			axis: "vertical",
			overscroll: "contain",
			scrollbar: "always",
			scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
		});
		const footer = new Text("", 0, 0);
		this.body = body;
		this.header = header;
		this.footer = footer;
		this.scrollView = scrollView;
		this.theme = theme;
		this.tui = tui;
		this.keybindings = keybindings;
		this.onDone = done;
		this.logicalLines = logicalLines;
		this.numberWidth = numberWidth;
		this.rebuildThemedText();
	}

	private rebuildThemedText(): void {
		this.header.setText(this.theme.fg("accent", ` System Prompt · ${this.logicalLines.length} lines `));
		this.body.setText(
			this.logicalLines
				.map(
					(line, index) =>
						`${this.theme.fg("muted", `${String(index + 1).padStart(this.numberWidth)} │`)} ${line}`,
				)
				.join("\n"),
		);
		this.footer.setText(this.theme.fg("dim", VIEWER_HELP));
	}

	invalidate(): void {
		this.rebuildThemedText();
	}

	render(width: number): string[] {
		// Custom screens and overlays use render(width), not native viewport layout.
		// Explicitly size the ScrollView in both regular and fullscreen modes.
		const bodyWidth = this.scrollView.getContentWidth(width);
		const content = this.body.render(bodyWidth);
		const terminalRows = Math.max(1, this.tui.terminal.rows);
		const header = terminalRows >= 3 ? this.header.render(width).slice(0, 1) : [];
		const footer = terminalRows >= 4 ? this.footer.render(width).slice(0, 1) : [];
		const viewportHeight = Math.max(1, terminalRows - header.length - footer.length);
		this.scrollView.updateLayout(content.length, viewportHeight, () => this.tui.requestRender());
		const offset = this.scrollView.scrollTop;
		const visible = content.slice(offset, offset + viewportHeight);
		const maxOffset = Math.max(0, content.length - viewportHeight);
		const thumbHeight = Math.max(
			1,
			Math.min(viewportHeight, Math.round((viewportHeight * viewportHeight) / Math.max(1, content.length))),
		);
		const thumbTop = maxOffset === 0 ? 0 : Math.round((offset / maxOffset) * (viewportHeight - thumbHeight));
		const scrolled = visible.map((line, index) => {
			if (width <= 1) return line;
			const thumb = index >= thumbTop && index < thumbTop + thumbHeight;
			return `${line}${this.theme.fg(thumb ? "scrollbarThumb" : "scrollbarTrack", thumb ? "█" : "│")}`;
		});
		return [...header, ...scrolled, ...footer].map((line) => truncateToWidth(line, width, ""));
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") return undefined;
		this.scrollView.scrollBy(event.wheelDelta ?? 0);
		this.tui.requestRender();
		return { handled: true };
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.up")) {
			this.scrollView.scrollBy(-1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.scrollView.scrollBy(1);
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollView.scrollBy(-(this.scrollView.viewportHeight || 1));
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollView.scrollBy(this.scrollView.viewportHeight || 1);
		} else if (kb.matches(data, "tui.altScreen.top") || matchesKey(data, Key.home)) {
			this.scrollView.scrollToStart();
		} else if (kb.matches(data, "tui.altScreen.bottom") || matchesKey(data, Key.end)) {
			this.scrollView.scrollToEnd();
		} else if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel")) {
			this.onDone();
			return;
		} else {
			return;
		}
		this.tui.requestRender();
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("system-prompt", {
		description: "Display the current system prompt",
		handler: async (_args, ctx) => {
			const prompt = ctx.getSystemPrompt();
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The system prompt viewer is available only in interactive TUI mode.", "warning");
				return;
			}

			await ctx.ui.custom<null>(
				(tui, theme, keybindings, done) => new PromptViewer(prompt, tui, theme, keybindings, () => done(null)),
				{
					// A capturing overlay keeps fullscreen page/jump keys out of the transcript.
					overlay: true,
					overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" },
				},
			);
		},
	});
}
