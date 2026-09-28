# Idle exit

Ctrl+D exits Pi only when the agent is idle and the main editor is empty. During an agent run, Ctrl+D does nothing; use Escape to interrupt it.

Pi reserves Ctrl+D for its built-in exit action. For this extension to receive the key, add these entries to `~/.pi/agent/keybindings.json` (merge them with any existing settings):

```json
{
  "app.exit": [],
  "tui.editor.deleteCharForward": "delete"
}
```

Reload Pi with `/reload`. Ctrl+D no longer deletes characters in the editor; use the Delete key instead. The built-in Ctrl+D behavior in session and tree pickers is unchanged.

Pi may warn that this shortcut overlaps `app.tree.filter.default`. That binding is used in the tree picker, while this extension handles the main editor, so the warning does not prevent either from working.
