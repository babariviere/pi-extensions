# Background jobs

Standalone session-owned shell jobs for Pi 1.1 or newer. The standalone sandbox
extension is required, even when sandbox policy is off. Every launch requests a
sandbox-wrapped command through `sandboxWrapCommand(pi, command)`; missing or
failed policy services refuse launch rather than falling back to an unchecked shell.

## Native tool

Use jobs only for long-running commands. Use regular `bash` for short commands
and `codemode` with `Promise.allSettled` to run independent tool calls in parallel.
Parallelism alone is not a reason to start jobs. After starting jobs, do other work
or finish the turn and rely on automatic completion notifications.
Do not repeatedly poll `wait`, `status`, or `logs`.
Use `wait` only when the next step genuinely depends on a job finishing, and
inspect logs after completion or when diagnosing a running job.

- `jobs({ action: "start", name, command, cwd? })`: launch a named Bash command.
- `jobs({ action: "status" })`: list live and recent handles without output.
- `jobs({ action: "wait", id, waitMs? })`: wait up to 30 seconds by default, maximum 120 seconds.
- `jobs({ action: "logs", id, maxChars? })`: read the output tail, default 4000 characters,
  maximum 20000. A terminal result suppresses the completion notification.
- `jobs({ action: "stop", id })`: cancel the job and its subprocess group.

This tool has native `codemode` exposure, annotation hints, output schemas and
structured results. Pi configuration controls native codemode. This extension
does not activate or override it and does not load an execution runtime or MCP
transport. Full workflow instructions are available through
`await describeNamespace("jobs")`. Example native script:

```ts
// For a test suite expected to run a long time:
const job = await tools.jobs({ action: "start", name: "tests", command: "npm test" });
return job;
// Do other work or finish the turn. A follow-up will announce completion.
```

The `action` parameter is required, with arguments validated for that action.
The old `jobs_*` tool names are no longer registered. Annotation hints
conservatively cover all actions, including shell launches and cancellations.

## Lifetime and limits

Jobs are owned by the session, not a script, turn or tool-call abort signal.
They finish on command exit, `jobs({ action: "stop", id })`, session replacement/reload/shutdown, or
the 2-hour lifetime cap. Child sessions and background agent attempts never
register jobs tools, preventing recursive background workflows.

Pending unclaimed completions are grouped into one follow-up when the parent is
idle, listing each finished job's name, handle, state, exit code, and output path.
Jobs finishing close together are coalesced over a 150 ms window. Completions
during an active turn are collected when the parent settles.
A terminal wait or log read claims its result and suppresses that wake-up. Reading
logs while the job is still running does not claim its later completion. Stopped
jobs never wake the model. Use `jobs({ action: "logs", id })` to inspect completion output;
notifications contain the handle and output path, not an unbounded log.

Defaults are unchanged and are not configurable: maximum 20 live jobs, 50 recent
terminal handles, 8 MiB captured output per job, and the limits above. `cwd` must
be an existing absolute directory; omitted `cwd` uses the tool context directory.
Output files live in temporary directories and are deleted during session cleanup.
The shell inherits the host environment, so sandbox policy is a filesystem/process
guardrail, not credential isolation. Tool annotations are hints, not permission grants.
