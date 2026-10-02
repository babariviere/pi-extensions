# System prompt preview

`/system-prompt` displays the effective system prompt in an interactive TUI
viewer. The prompt is line-numbered and uses Pi's native scroll view, so its
viewport follows the available terminal height and width. Use the configured
up/down and page keys to scroll, Home/End to jump, and Enter/Escape to close.
The regular terminal mode uses a terminal-row-sized keyboard-scrollable window
and leaves normal terminal scrollback behavior intact.

The viewer is terminal-only. In RPC, JSON, and print modes, `/system-prompt`
shows a warning instead of trying to open an unsupported custom TUI component.
