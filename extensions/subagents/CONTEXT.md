# subagents — domain vocabulary

Terms used across the subagents extension. Keep names in code and docs aligned
with these.

- **run**: one custom-agent invocation (one child `pi` process). Modelled by
  `RunRequest` in, `RunResult` out.
- **batch**: the set of runs launched together by a single `subagent` tool call.
  Runs in a batch share one `runId` and one `RunContext`.
- **run backend**: the seam that turns a batch of `RunRequest`s into
  `RunResult`s. One interface (`RunBackend`), two **adapters**:
  - **headless adapter** (`headless.ts`): spawns `pi` child processes, waits for
    exit.
  - **herdr adapter** (`herdr-backend.ts`): launches `pi` in live herdr panes,
    waits for each pane to settle.
  `backend.ts` owns `selectBackend()`, which picks the adapter by environment.
- **run context** (`RunContext`): the ambient inputs a backend needs for a batch
  (session id/file, runId, cwd, timeout, abort signal, status callback).
- **output resolution**: the rule that decides a run's final output text and
  whether it succeeded, from the submit_result file, then the child session
  transcript, then a backend-specific fallback source.
- **status probe**: the read-only view of a herdr pane's agent status that the
  pane-lifecycle machine polls to decide when a run has finished or its pane is
  gone.
