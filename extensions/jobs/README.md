# Background jobs

Standalone session-owned shell jobs for Pi 1.0 or newer. The standalone sandbox
extension is required, even when sandbox policy is off. Every launch requests a
sandbox-wrapped command through `sandboxWrapCommand(pi, command)`; missing or
failed policy services refuse launch rather than falling back to an unchecked shell.

## Native tools

- `jobs_start({ name, command, cwd? })`: launch a named Bash command.
- `jobs_status({})`: list live and recent handles without output.
- `jobs_wait({ id, waitMs? })`: wait up to 30 seconds by default, maximum 120 seconds.
- `jobs_logs({ id, maxChars? })`: read the output tail, default 4000 characters,
  maximum 20000. A terminal result suppresses the completion notification.
- `jobs_stop({ id })`: cancel the job and its subprocess group.

These tools have native `codemode` exposure, annotation hints, output schemas and
structured results. Pi configuration controls native codemode. This extension
does not activate or override it and does not load an execution runtime or MCP
transport. Full workflow instructions are available through
`await describeNamespace("jobs")`. Example native script:


```ts
const job = await tools.jobs_start({ name: "tests", command: "npm test" });
return await tools.jobs_wait({ id: job.id });
```

## Lifetime and limits

Jobs are owned by the session, not a script, turn or tool-call abort signal.
They finish on command exit, `jobs_stop`, session replacement/reload/shutdown, or
the 2-hour lifetime cap. Child sessions and background agent attempts never
register jobs tools, preventing recursive background workflows.

An unclaimed completion sends one follow-up message when the parent is idle.
A terminal wait or log read claims its result and suppresses that wake-up. Reading
logs while the job is still running does not claim its later completion. Stopped
jobs never wake the model. Use `jobs_logs` to inspect completion output;
notifications contain the handle and output path, not an unbounded log.

Defaults are unchanged and are not configurable: maximum 20 live jobs, 50 recent
terminal handles, 8 MiB captured output per job, and the limits above. `cwd` must
be an existing absolute directory; omitted `cwd` uses the tool context directory.
Output files live in temporary directories and are deleted during session cleanup.
The shell inherits the host environment, so sandbox policy is a filesystem/process
guardrail, not credential isolation. Tool annotations are hints, not permission grants.
