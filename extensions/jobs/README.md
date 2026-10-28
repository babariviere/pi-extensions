# Background jobs

Standalone session-owned shell jobs for Pi 1.4 or newer and Node.js 24+. The standalone sandbox
extension is required, even when sandbox policy is off. Every launch requests a
sandbox-wrapped command through `sandboxWrapCommand(pi, command)`; missing or
failed policy services refuse launch rather than falling back to an unchecked shell.

## Native tool

Use jobs for long-running commands, `bash` for short ones, and `codemode` for
independent tool calls. After launch, do independent work or **end the turn**, even
if the next step depends on completion. Ending the turn leaves jobs running;
completion wakes the agent automatically. Avoid polling or shell sleeps.

- `jobs({ action: "start", name, command, cwd? })`: launch a named Bash command.
- `jobs({ action: "list" })`: list live and recent handles, including `outputPath`.
- `jobs({ action: "status" })`: compatibility alias for `list`.
- `jobs({ action: "wait", id, waitMs? })`: wait up to 30 seconds by default, maximum 120 seconds.
  Optional bounded synchronization or terminal-result acknowledgement, not polling.
  Returns `outputPath`; a terminal result suppresses the completion notification.
  If it returns `running`, end the turn rather than waiting again. Cancelling a wait
  releases the tool call but does not stop or claim the session-owned job.
- `jobs({ action: "stop", id })`: cancel the job and its subprocess group.

Every job result includes `outputPath`. Let jobs capture stdout/stderr instead of
redirecting them elsewhere, so this path and completion notifications contain useful
logs. Use `read` to inspect the file, or `bash`
with `rg` to search it or `tail` to read its end. The `logs` action has been removed;
use these existing file tools instead. List/status calls and direct file reads do not
acknowledge completion or suppress pending notifications; a terminal `wait` does.

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

On the automatic completion follow-up, inspect its output path and continue the
dependent work. To recover current handles for diagnostics (not polling):

```ts
text(await tools.jobs({ action: "list" }));
```

The `action` parameter is required, with arguments validated for that action.
The old `jobs_*` tool names are no longer registered. Annotation hints
conservatively cover all actions, including shell launches and cancellations.

## Lifetime and limits

Jobs are owned by the session, not a script, turn or tool-call abort signal.
Running jobs survive `/reload`: the new extension reconnects to the same process-local
owner, preserving handles, output capture and the original lifetime deadline. Existing
jobs retain their implementation until they finish; new launches use the reloaded sandbox
service. Detached runtimes cannot launch jobs or send completion notifications.
They finish on command exit, `jobs({ action: "stop", id })`, session replacement/shutdown, or
the 2-hour lifetime cap. A job is finished once its shell exits: output is read for
another 500 ms, then capture stops, so background processes it left behind (for
example `server &`) cannot keep the job running. Child sessions and background agent attempts never
register jobs tools, preventing recursive background workflows.

File-backed sessions persist handles, terminal status, logs and completion acknowledgements
under `<session-file>.jobs/<session-identity>/`. Resume the same session to inspect them;
switching or forking does not transfer jobs to the destination session. Quit still cancels
running commands and their subprocess groups, rather than keeping a shell service alive.
Unclaimed completed results remain available for notification on resume.

After a hard crash, an unfinished persisted launch becomes **`interrupted`**, with an
unknown exit code. Recovery never reruns a command or kills a recorded PID. The command
may already have changed files or external systems, and a hard crash may leave subprocesses
alive. Inspect output and side effects before explicitly starting another job. Admission
is recorded before spawning, so an interrupted record can also represent a command that
never started. This is durable tracking, not process supervision or exactly-once execution.

An unknown handle fails immediately. List once to find retained handles, or inspect its
previously recorded output path; do not keep waiting on an unknown handle. Sessions without
a backing file retain process-local handles across reload only, and delete temporary logs
on shutdown.

Pending unclaimed completions are grouped into one follow-up when the parent is
idle, listing each finished job's name, handle, state, exit code, and output path.
The follow-up is sent after a 2-second quiet period. Each new completion resets the
quiet period, so staggered exits share one message, and the wait never exceeds 10
seconds from the first pending completion. Jobs started within 5 seconds of each
other form a batch: a successful completion is held while the rest of its batch is
still running, for up to 60 seconds, so tests, typecheck and lint started together
report once. A failure skips that hold and is announced after the normal quiet
period, since the agent can act on it right away. Jobs started separately, such as
an earlier dev server, never hold a batch. Completions during an active turn are
collected when the parent settles, which restarts the same grouping window so jobs
exiting right after the turn join them.
A terminal wait claims its result and suppresses that wake-up. Reading the output
file does not claim completion, even after exit. Stopped jobs never wake the model.
For persistent sessions, a notification receipt is committed before delivery (**at-most-once**).
A crash or failed delivery can lose the wake-up, but status and logs remain readable.
Storage failures disable new launches and completion acknowledgements, not silently fall
back to memory. One process owns a session's journal at a time; a competing owner is refused.
Use `read` or `bash` with `rg`/`tail` to inspect completion output;
notifications contain the handle and output path, not an unbounded log.

Defaults are unchanged and are not configurable: maximum 20 live jobs, 50 recent
terminal handles, 8 MiB captured output per job, and the limits above. `cwd` must
be an existing absolute directory; omitted `cwd` uses the tool context directory.
Persistent storage directories are private (0700), with database and log files private
(0600). Logs can contain secrets. Persistent logs are retained even after a handle leaves
the 50-result history; no TTL or automatic log deletion applies. Remove a session's `.jobs`
directory only after its owner has stopped if you want to discard this history. In-memory
sessions instead use temporary directories deleted during session cleanup.
The shell inherits the host environment, so sandbox policy is a filesystem/process
guardrail, not credential isolation. Tool annotations are hints, not permission grants.
