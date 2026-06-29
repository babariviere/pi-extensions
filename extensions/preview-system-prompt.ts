/**
 * Preview System Prompt Extension
 *
 * Displays the current system prompt via /system-prompt command.
 * Uses a custom scrollable view to display the full prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("system-prompt", {
		description: "Display the current system prompt",
		handler: async (_args, ctx) => {
			const prompt = ctx.getSystemPrompt();

			// Handle various return types
			let promptText: string;
			if (typeof prompt === "string") {
				promptText = prompt;
			} else {
				promptText = String(prompt);
			}

			const lines = promptText.split("\n");
			let scrollOffset = 0;
			const visibleLines = 20;
			const maxOffset = Math.max(0, lines.length - visibleLines);

			await ctx.ui.custom<null>((tui, theme, kb, done) => {
				function render(width: number): string[] {
					const result: string[] = [];
					const add = (s: string) => result.push(truncateToWidth(s, width));

					// Top border
					add(theme.fg("accent", "─".repeat(width)));
					add(theme.fg("accent", " System Prompt "));
					add(theme.fg("accent", "─".repeat(width)));
					result.push("");

					// Visible content
					const start = Math.min(scrollOffset, lines.length);
					const end = Math.min(start + visibleLines, lines.length);
					for (let i = start; i < end; i++) {
						const lineNum = String(i + 1).padStart(3, " ");
						add(`${theme.fg("muted", lineNum)} ${lines[i]}`);
					}

					// Scroll indicator
					result.push("");
					const scrollBar = maxOffset > 0
						? `${theme.fg("dim", `[${scrollOffset}/${maxOffset}]`)} ${theme.fg("accent", "↑↓")} scroll ${theme.fg("dim", "• Enter")} close`
						: `${theme.fg("dim", "[no scroll needed]")} ${theme.fg("dim", "• Enter")} close`;
					add(scrollBar);

					// Bottom border
					add(theme.fg("accent", "─".repeat(width)));

					return result;
				}

				function handleInput(data: string) {
					if (matchesKey(data, Key.up)) {
						scrollOffset = Math.max(0, scrollOffset - 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.down)) {
						scrollOffset = Math.min(maxOffset, scrollOffset + 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.pageUp)) {
						scrollOffset = Math.max(0, scrollOffset - visibleLines);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.pageDown)) {
						scrollOffset = Math.min(maxOffset, scrollOffset + visibleLines);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						done(null);
						return;
					}
					if (matchesKey(data, Key.escape)) {
						done(null);
						return;
					}
				}

				return {
					render,
					invalidate: () => {},
					handleInput,
				};
			});
		},
	});
}