# Todos

File-based task tracking with the `/todos` manager and native Pi tools. Each todo
is a markdown file with JSON front matter in `<cwd>/.pi/todos`, or the directory
selected by `PI_TODO_PATH`. Night-run participants use the run's ledger store.

## Native tools

Pi owns discovery and execution. These tools are registered directly, grouped
under the `todo` namespace, and exposed to native `codemode` as:

| Tool | Action |
| --- | --- |
| `tools.todo_list({})` | Open todos, assigned first |
| `tools.todo_listAll({})` | All todos, including closed items |
| `tools.todo_get({ id })` | Full record with markdown body |
| `tools.todo_create({ title, tags?, status?, body? })` | Create a todo |
| `tools.todo_update({ id, title?, tags?, status?, body? })` | Replace supplied fields |
| `tools.todo_append({ id, body })` | Append progress or blockers |
| `tools.todo_delete({ id })` | Delete and return the record |
| `tools.todo_claim({ id, force? })` | Assign to this session |
| `tools.todo_release({ id, force? })` | Release the assignment |

Results are structured records or arrays, with ids formatted as `TODO-<hex>`.
For example, in native `codemode`:

```ts
const todo = await tools.todo_create({ title: "Verify the migration" });
await tools.todo_claim({ id: todo.id });
await tools.todo_append({ id: todo.id, body: "Focused tests passed." });
return await tools.todo_update({ id: todo.id, status: "closed" });
```

## Commands and safeguards

`/todos [search]` opens the existing interactive manager with work, refine,
close/reopen, release, delete, copy, and view actions. Without UI it prints the
list. When open todos exist, the agent receives native tool workflow guidance.

Mutations preserve file locks and assignment checks. `force` overrides assignment,
not the file lock. Stale locks require interactive confirmation before removal.
Closing a `night`-tagged todo requires valid evidence (or a reason for skipping).
During night planning, reads remain available but all todo mutations are refused
until planning ends after approval. The night sandbox can deny direct access to
the store while trusted host-side todo tools continue managing it.

`<todo-dir>/settings.json` controls startup garbage collection: `gc` defaults to
`true`, and `gcDays` defaults to `7` for closed todos.
