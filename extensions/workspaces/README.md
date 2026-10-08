# Workspaces

`/workspace` manages jj workspaces with optional Herdr integration:

- `list`: list workspaces and whether each is open in Herdr.
- `create <name> [revision]`: create a workspace, copy configured local files, and open it.
- `switch [name]`: focus or open a workspace, prompting when no name is given.
- `delete [name]`: forget a workspace, remove its directory only if managed, and close it.

With no arguments, the command opens an interactive dashboard (or lists in
non-interactive modes). The current and default workspaces cannot be deleted.

Configure the top-level `workspaces` key in `~/.pi/agent/settings.json`:

```json
{
  "workspaces": {
    "root": "~/.herdr/workspaces",
    "copyFiles": ["mise.local.toml"]
  }
}
```

New directories use `<root>/<repo>/<name>`. Existing workspaces use their jj
recorded root paths, even when their directory names differ from their workspace
names or they live outside that layout. Legacy workspaces without recorded paths
fall back to the configured layout (and the actual current workspace root when
its name can be inferred). Other lookup failures are reported instead of guessed.
Directories outside the managed root are left on disk when forgotten.

Absolute and relative `.jj/repo` pointers resolve the store-owning checkout;
relative pointers are based at `.jj`. This keeps repository grouping and local
file copying consistent when running from a secondary workspace.

With jj 0.46, `workspace add` creates a native Git worktree when the current
workspace is colocated and `git.colocate` is true. No manual `.git` grafting is
needed. Existing non-colocated workspaces are not automatically converted.
Deletion uses `jj workspace forget` before removing a managed directory, allowing
jj to unlink its native Git worktree bookkeeping.
