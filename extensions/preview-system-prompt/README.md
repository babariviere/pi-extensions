# System prompt preview

`/system-prompt` displays the effective system prompt in an interactive TUI
overlay. The prompt is line-numbered, and its scrollable viewport follows the
terminal height and width. Use the configured up/down and page keys to scroll,
Home/End to jump, and Enter/Escape to close. In fullscreen mode, the mouse wheel
also scrolls the prompt. Viewer scrolling does not move the underlying transcript.
The regular terminal mode uses a terminal-row-sized keyboard-scrollable window
and leaves normal terminal scrollback behavior intact.

The viewer is terminal-only. In RPC, JSON, and print modes, `/system-prompt`
shows a warning instead of trying to open an unsupported custom TUI component.
