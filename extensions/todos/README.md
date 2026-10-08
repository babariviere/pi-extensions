# Todos

File-based task tracking with the `/todos` manager and native Pi tools. Each todo
is a markdown file with JSON front matter in `<cwd>/.pi/todos`, or the directory
selected by `PI_TODO_PATH`. Night-run participants use the run's ledger store.

## Native tool

Pi owns discovery and execution. One `todo` tool is registered directly under
the `todo` namespace and exposed to native `codemode`:

| Tool | Action |
| --- | --- |
| `tools.todo({ action: "list" })` | Open todos, assigned first |
| `tools.todo({ action: "listAll" })` | All todos, including closed items |
| `tools.todo({ action: "get", id })` | Full record with markdown body |
| `tools.todo({ action: "create", title, tags?, status?, body? })` | Create a todo |
| `tools.todo({ action: "update", id, title?, tags?, status?, body? })` | Replace supplied fields |
| `tools.todo({ action: "append", id, body })` | Append progress or blockers |
| `tools.todo({ action: "delete", id })` | Delete and return the record |
| `tools.todo({ action: "claim", id, force? })` | Assign to this session |
| `tools.todo({ action: "release", id, force? })` | Release the assignment |

Results are structured records or arrays, with ids formatted as `TODO-<hex>`.
The `action` parameter is required. Arguments are validated for the selected
action. The old `todo_*` tool names are no longer registered; all actions,
including `listAll`, `delete`, and `release`, are available on this one tool.
Annotation hints conservatively cover all actions, including mutations.
For example, in native `codemode`:

```ts
const todo = await tools.todo({ action: "create", title: "Verify the migration" });
await tools.todo({ action: "claim", id: todo.id });
await tools.todo({ action: "append", id: todo.id, body: "Focused tests passed." });
return await tools.todo({ action: "update", id: todo.id, status: "closed" });
```

## Commands and safeguards

`/todos [search]` opens the existing interactive manager with work, refine,
close/reopen, release, delete, copy, and view actions. Without UI it prints the
list. When open todos exist, the agent receives native tool workflow guidance.

Mutations preserve file locks and assignment checks. `force` overrides assignment,
not the file lock. Stale locks require interactive confirmation before removal.
Closing a `night`-tagged todo requires valid evidence (or a reason for skipping).
The night sandbox can deny direct access to
the store while trusted host-side todo tools continue managing it.

`<todo-dir>/settings.json` controls startup garbage collection: `gc` defaults to
`true`, and `gcDays` defaults to `7` for closed todos.
