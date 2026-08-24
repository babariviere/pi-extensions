# taptap

Requires a double tap on <kbd>Esc</kbd> before pi cancels a running agent turn.

A single <kbd>Esc</kbd> aborts the current run immediately, which is easy to
trigger by accident. While the agent is streaming, `taptap` swallows the first
tap, shows an `esc again to cancel` hint in the footer, and only cancels when a
second tap lands within 600ms.

While the agent is idle there is nothing to abort, so <kbd>Esc</kbd> is passed
straight through. pi's own double-<kbd>Esc</kbd> history picker (the tree/fork
selector on an empty editor) therefore still opens on two taps instead of four.

## How it works

pi dispatches <kbd>Esc</kbd> in `CustomEditor.handleInput` by looking up
`app.interrupt` and calling the public `onEscape` field. `taptap` subclasses
`CustomEditor`, intercepts <kbd>Esc</kbd> before that lookup when
`ctx.isIdle()` is false, and forwards to `this.onEscape?.()` on the second tap.

Because it calls pi's own handler rather than reimplementing it, every native
<kbd>Esc</kbd> behaviour still works:

- restore queued messages to the editor
- abort a running bash command
- leave bash (`!`) mode
- the `doubleEscapeAction` tree/fork picker when the editor is empty
- abort the agent turn

<kbd>Esc</kbd> is passed straight through while the autocomplete popup is open,
so it still cancels completion on the first tap.

## Notes

- Leave `app.interrupt` bound to `escape` in `~/.pi/agent/keybindings.json`. The
  interception happens upstream of the keybinding match, so rebinding is neither
  needed nor helpful.
- The hint renders through `ctx.ui.setStatus`, which the built-in footer and any
  footer reading `footerData.getExtensionStatuses()` will display.
- Only one extension can own the editor component. If another extension calls
  `ctx.ui.setEditorComponent`, load order decides the winner.
