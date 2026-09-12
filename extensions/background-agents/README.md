# Background agents

Background agents are a private, single-host control plane for durable intake, investigation, specifications, implementation, verification, and reviewable GitHub pull requests. The controller owns the state; Pi provides the operator dashboard.

This extension is not a remote version of night mode. Night mode is local interactive session tooling and is **not used remotely**. A remote controller never starts a night-mode run, reads its ledger, or sends its reports.

## Safety contract

- The remote AWS host has the only writable SQLite database. **Remote SQLite is authoritative. Local synchronization is backup-only**, never a writable replica and never a merge mechanism.
- Merges are always human. The controller can push branches, create or edit draft PRs, link a `gh stack`, and mark an individually verified PR ready for review. It has no merge operation.
- Slack and Datadog are read-only sources. Slack never receives automatic replies, drafts, reactions, or other messages. Datadog never mutates monitors, incidents, dashboards, or production state.
- Linear polling is limited to the active cycle assigned to the authenticated identity through `assignee.isMe`. The only automatic mutation is a forward move from a backlog/unstarted state to the team's started state, preferring `In Progress`. Completed, cancelled, later, and human-changed states are preserved. No issue creation or comments are made.
- Questions never receive automatic responses. They may create a bounded private, read-only question brief with findings, sources, uncertainty, and confidence, but never code, a PR, an external response, or a provider mutation.
- Agents do not receive hidden chain-of-thought. The dashboard shows durable summaries, provenance, specifications, decisions, artifacts, confidence, and evidence.

## Architecture

The Node 24 controller runs independently of Pi and owns SQLite, source cursors, leases, state transitions, provider usage, recovery, backups, external-effect reconciliation, and the Unix socket. Source adapters persist normalized events before acknowledging or advancing a cursor. SQLite deduplicates events and links cases. Classification stores kind, disposition, scores, rationale, fingerprint, model/policy versions, and approved examples. Investigators retrieve bounded related-case summaries and current evidence.

The five roles are classifier, investigator, spec-planner, worker, and verifier. Classifiers are tool-free. Investigators and planners are read-only. A worker is the single writer for an admitted fix or one approved PR unit. A verifier independently replays evidence against exact commits. Large specifications are frozen into an ordered, sequential PR stack, one worktree and one writer per PR.

Attempts run in a fresh Herdr pane through a transient `systemd-run --user --pty --wait --collect` service. The primary checkout is read-only. Workers use dedicated worktrees and may update shared Git metadata, but verifier services use attempt-owned local clones and never write the authoritative checkout or shared `.git`. Evidence replay runs credential-free with a sterile home and no network. The controller, not an agent, performs GitHub mutations and authenticated CI verification.

The Pi extension is an owner-only Unix-socket client. In a normal interactive TUI session it opens the dashboard without blocking other extension startup. It does not open the dashboard in non-TUI modes or in worker sessions marked with `PI_BACKGROUND_AGENT_ATTEMPT=1`.

## Node and installation requirements

The package declares Node `>=18.0.0`. `extensions/background-agents/index.ts` and its client/UI imports remain Node 18-safe and must not import `node:sqlite`. The controller path under `extensions/background-agents/controller/` uses `node:sqlite` and requires Node 24.

Install the package and its existing dependencies on the AWS host. The controller script is:

```sh
npm run background-agents:controller
```

It reads `BACKGROUND_AGENTS_CONFIG` when set, otherwise `~/.pi/agent/background-agents.json`. The Pi extension uses `PI_BACKGROUND_AGENTS_SOCKET` when set, otherwise `~/.pi/agent/background-agents.sock`.

## Configuration

The complete configuration is JSON. An example configuration is available at `extensions/background-agents/examples/background-agents.json`; copy it to `~/.pi/agent/background-agents.json` and replace its placeholders before use. Unknown product concepts should not be added as fields. The following is the exact schema accepted by `config.ts`; omitted values use the defaults shown here. Paths beginning with `~/` are expanded from the controller user's home. Relative paths are resolved relative to the configuration file's directory.

| Field | Default | Meaning |
| --- | --- | --- |
| `configVersion` | `1` | Configuration version. Only `1` is accepted. |
| `databasePath` | `~/.pi/agent/background-agents.sqlite` | Authoritative SQLite database on the remote host. |
| `repositories` | `[]` | Repository records with `id`, `root`, `gitDir` (default `<root>/.git`), `remote` (default `origin`), `defaultBaseBranch` (default `main`), and `requiredChecks`. |
| `thresholds` | `{ "actionableMin": 70, "noiseMax": 30 }` | Global classifier thresholds. Both are integers from 0 to 100 and `noiseMax` must be below `actionableMin`. |
| `thresholds.scopes` | absent | Optional maps named exactly `source`, `service`, `monitor`, `environment`, and `repository`; each entry has `actionableMin` and `noiseMax`. |
| `pollIntervalsMs` | linear `300000`, datadog `60000`, slackReconnect `5000` | Poll/reconnect intervals in milliseconds. |
| `profiles` | `[]` | Isolated provider profiles. See below. |
| `systemd` | runtime `86400000`, memory `2147483648`, CPU `100`, processes `256` | `maxRuntimeMs`, `memoryLimitBytes`, `cpuQuotaPercent`, and `processLimit`. |
| `ci` | checks `[]`, wait `1800000` | `requiredChecks` and `maxWaitMs`. Repository checks are also supported. |
| `question` | runtime `60000`, attempts `1`, results `10` | Bounded read-only question analysis: `maxRuntimeMs`, `maxAttempts`, and `maxResults`. Monetary cost is not claimed because it is not measured. |
| `socket` | path `~/.pi/agent/background-agents.sock`, mode `0600`, max request `1048576` | `path`, optional numeric `ownerUid`, numeric `mode`, and `maxRequestBytes`. The mode cannot grant group/world access. |
| `rollout` | default `observe`, overrides `{}` | `defaultMode`, `sourceOverrides`, and `repositoryOverrides`. Modes are `observe`, `supervised`, and `autonomous-pr`. |
| `backup` | directory `~/.pi/agent/background-agent-backups`, interval `3600000`, retention `7` | `directory`, `intervalMs`, `retention`, and optional argv array `syncCommand`. |
| `sources` | manual enabled; Slack, Linear, Datadog disabled | Source-specific fields are listed below. |
| `classifier` | model `controller-default`, examples `12`, related cases `8`, max attempts `3`, retry backoff `30000` | `modelVersion`, optional `policyScope`, `exampleLimit`, `relatedCaseLimit`, `maxAttempts`, and `retryBackoffMs`. Failed classifier attempts are retried by the scheduler after the backoff until the bounded attempt budget is exhausted, then the intake case is blocked for human review. |
| `controller` | usage `300000`, scheduler `5000`, heartbeat `10000`, recovery `30000`, CI `60000` | Controller loop intervals: `usageMs`, `schedulerMs`, `heartbeatMs`, `recoveryMs`, and `ciMs`. |

A repository's exact shape is:

```json
{ "id": "repo-id", "root": "/srv/repositories/example", "gitDir": "/srv/repositories/example/.git", "remote": "origin", "defaultBaseBranch": "main", "requiredChecks": ["test"] }
```

A profile's exact shape is:

```json
{
  "id": "anthropic-background",
  "provider": "anthropic",
  "agentDir": "/srv/background-agent-profiles/anthropic",
  "authFiles": ["/srv/background-agent-credentials/anthropic-auth.json"],
  "allowedModels": ["<model-name>"],
  "allowedRoles": ["classifier", "investigator", "spec-planner", "worker", "verifier"],
  "maxBackgroundAttempts": 1,
  "interactiveReserve": 1,
  "usageStaleAfterMs": 900000
}
```

`provider` is `anthropic` or `openai`. `allowedRoles` uses only `classifier`, `investigator`, `spec-planner`, `worker`, and `verifier`. A profile is selected before an attempt and is never switched mid-attempt. Each profile has its own `agentDir`, `authFiles`, allowed models/roles, concurrency, interactive reserve, and stale-usage cutoff. SQLite stores profile IDs and usage, never OAuth tokens. By default only one model-consuming background attempt runs per profile. Stale or unavailable usage pauses expensive work instead of rotating profiles to evade limits.

Source fields are:

- `sources.manual.enabled`.
- `sources.slack.enabled`, `url`, and optional `credentialPath`.
- `sources.linear.enabled`, `url`, optional `credentialPath`, optional `pageSize`, and `repositoryMappings`.
- `sources.datadog.enabled`, `url`, optional `credentialPath`, `monitorQueries`, `errorQueries`, `repositoryMappings`, and `overlapMs`.

Each Datadog query has `id`, `query`, and optional `repository` and `service`. Mapping values identify configured repository IDs. The default URLs are `https://slack.com/api/apps.connections.open`, `https://api.linear.app/graphql`, and `https://api.datadoghq.com`.

## Credential files

Configuration rejects inline keys whose names look like tokens, secrets, passwords, API keys, or client secrets. Store a file reference in `credentialPath` or `authFiles`, never a credential value in JSON. Enabled Slack, Linear, and Datadog sources require `credentialPath`.

Source credential files must be regular, non-symlink files owned by the controller user and have no group/world permission bits. `0600` or stricter, such as `0400`, is appropriate. The controller accepts either a JSON string or a JSON object:

- Slack: a string, or an object containing `token`, `appToken`, or `accessToken`.
- Linear: a string, or an object containing `token`, `apiKey`, or `accessToken`.
- Datadog: an object containing `apiKey`/`api_key`/`key` and `appKey`/`applicationKey`/`application_key`.

Profile `authFiles` are copied into an attempt-owned profile. They must be regular files with no group/world permission bits. The copies are created as `0600`; the isolated profile and session directories are `0700`. Keep OAuth and provider files separate per profile. Never put secrets in Herdr arguments, unit arguments, SQLite, dashboard responses, or logs.

## Provider setup and boundaries

### Slack Socket Mode

Create a Slack app for the workspace, enable Socket Mode, and create an app-level token with `connections:write`. Subscribe only to the bot events needed for intake. For app mentions, use the corresponding mention subscription and its minimum read scope. For message events, Slack may require the relevant history scope such as `channels:history`, `groups:history`, `im:history`, or `mpim:history`. Install the app only where needed and store the `xapp-...` app token in the restricted Slack credential file. The controller opens the outbound Socket Mode WebSocket, persists events before acknowledging envelopes, reconnects, and deduplicates by validated workspace/team and event ID. Event envelopes without a consistent workspace/team identity are rejected without acknowledgement. It does not post or react. No public inbound HTTP endpoint is required.

### Linear

Use a token that can read the authenticated user's identity, active cycles, issues, teams, and workflow states, and can update an issue state if `supervised` or `autonomous-pr` operation is intended. The adapter's fixed query is the active cycle with `assignee.isMe`; `pageSize` controls pagination. `repositoryMappings` maps fetched Linear fields to a configured repository ID. Mapping precedence is explicit issue identifier (`issue:ENG-1`, then `ENG-1`), team ID (`team-id:<id>`, then the raw ID), and team key (`team-key:ENG`, then `ENG`). The first matching key wins in that order. The adapter never reads an unqueried `issue.repository` field. Unmapped cases remain private intake and cannot admit code work until an operator supplies a repository.

When real investigation or specification starts, the narrow effect layer may advance a backlog/unstarted issue to the team's started state, choosing a state named `In Progress` first. It will not move work backward, reopen terminal work, create issues, add comments, or automatically set review/done/completed/cancelled states. Reconciliation protects a newer human change and stable operation keys make retries idempotent.

### Datadog

Use an API key and application key with read-only permissions for the configured monitor and log/error queries. Do not grant monitor, incident, dashboard, or production mutation permissions. `monitorQueries` call monitor search; `errorQueries` call log event search. Polling uses `overlapMs`, a persisted watermark, stable fingerprints, and deduplication. Datadog access is read-only.

### GitHub and `gh stack`

The host must provide authenticated `git` and GitHub CLI access for the controller user. The preflight checks these exact commands:

```sh
git --version
gh --version
gh stack --help
```

The controller creates deterministic branches named `background/<case-id>/<ordinal>`, uses one dedicated worktree per PR, pushes through controller-owned effects, creates draft PRs, edits PR metadata, links stack branches with `gh stack link <bottom-branch> <next-branch> ...`, and runs `gh pr ready <number>` only after verification and required CI pass. There is no merge command. Stack items execute bottom to top; do not run concurrent writers on one linear stack.

## Host deployment

Background attempts require Linux, systemd `247` or newer, cgroup v2 `memory`, `cpu`, and `pids` controllers, Herdr, Git, GitHub CLI, and `gh stack`. The controller preflight also checks `systemd-run --user --pty --wait --collect --help` and the required executable paths. Missing isolation capabilities fail closed.

The controller service is a systemd **user** service. A user manager must be running on the AWS host. Copy the unit, edit its Node 24, repository, and `tsx` paths, then enable lingering for the operator so it survives logout:

```sh
mkdir -p ~/.config/systemd/user
cp extensions/background-agents/systemd/background-agents-controller.service ~/.config/systemd/user/
loginctl enable-linger <operator>
systemctl --user daemon-reload
systemctl --user enable --now background-agents-controller.service
systemctl --user is-active background-agents-controller.service
journalctl --user-unit background-agents-controller.service -f
```

Edit the `ExecStart` paths in `extensions/background-agents/systemd/background-agents-controller.service` for the installed Node 24 binary, repository checkout, and `tsx` loader. Replace the worktree-root `ReadWritePaths` placeholder with the configured worktree root, and add one shared `.git` `ReadWritePaths` entry for each configured repository. Do not add primary checkout roots to `ReadWritePaths`; primary checkout source remains read-only. The static service unit cannot automatically detect omitted `ReadWritePaths` entries. Configure them manually and use the controller's host preflight for executable, cgroup, credential, and path checks. The service unit is for the controller. Tool-capable attempts receive additional transient isolation through `systemd-run --user --pty --wait --collect`, including `ProtectSystem=strict`, role-specific home/network isolation, `NoNewPrivileges`, an empty capability set, private devices/tmp, process/memory/CPU/runtime limits, `KillMode=control-group`, and explicit read/write paths. Verifier services additionally use `ProtectHome=tmpfs`, `PrivateNetwork=yes`, an empty credential-free profile, and read-only authoritative Git metadata. The service itself writes only the configured control-plane directory; configure `ReadWritePaths` if `databasePath`, `socket.path`, or `backup.directory` are elsewhere.

Herdr must be available to the same user manager and PATH. The controller creates the pane, waits for its shell, then launches the transient unit. A pane or unit failure is reconciled before an attempt is declared dead. The `PI_BACKGROUND_AGENT_ATTEMPT=1` marker prevents a worker session from opening the operator dashboard.

### Worktree and `.git` permissions

Configure `repositories[].root` as the primary checkout and `repositories[].gitDir` as its shared Git metadata path. Worktrees are outside the primary checkout. A worker may write only its dedicated worktree, its attempt-specific temporary/profile/session paths, and the shared `.git` metadata needed by Git worktree operations. The primary checkout source tree remains read-only. Git worktree and shared metadata mutations are serialized per repository. Dirty worktrees are preserved and quarantined for human review, never silently cleaned or deleted.

## Dashboard and Unix socket

Start the controller before opening Pi. The extension auto-opens the dashboard in a normal interactive TUI when the socket is available. Otherwise Pi remains usable and reports the controller outage. `/background` reopens it.

Pi commands:

| Command | Effect |
| --- | --- |
| `/background` | Open the dashboard. |
| `/background bug` | Prompt for a bug title and details, then submit a manual case. |
| `/background feature` | Prompt for a feature title and details, then submit a manual case. |
| `/background open <caseId>` | Open a selected case. |
| `/background resume <caseId>` | Record resume for the case and open it. |

The socket is newline-delimited JSON using protocol `background-agents.v1`. Requests have `version: 1` and a unique `id`. Supported request types are `dashboard.get`; `case.submit` with `source`, `title`, `body`, and optional `repository`; `case.action` with `caseId`, `action`, and optional `comment`; `spec.feedback`; `spec.approve` with `specVersion` and `permissions`; `classifier.correct`; `rollout.set` with `scope`, `value`, and a source or repository target when applicable; `emergency.stop` with `enabled`; `pane.focus` with `paneId`; and `evidence.reproduce` with `caseId` and `manifestId`. Case actions are `approve-specification`, `request-changes`, `resume`, `reclassify`, `cancel`, `mark-handled`, and `reject`. Responses echo `version` and `id` and contain either `ok: true, result` or `ok: false, error`.

For a dependency-free socket probe, this exact Node command requests a dashboard snapshot:

```sh
node --input-type=module <<'EOF'
import { connect } from "node:net";
const socket = process.env.PI_BACKGROUND_AGENTS_SOCKET ?? `${process.env.HOME}/.pi/agent/background-agents.sock`;
const request = JSON.stringify({ version: 1, id: `probe-${Date.now()}`, type: "dashboard.get" }) + "\n";
const client = connect({ path: socket }, () => client.write(request));
client.setEncoding("utf8");
client.on("data", (data) => { process.stdout.write(data); client.end(); });
client.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
EOF
```

The socket defaults to owner-only mode `0600`, validates ownership, and limits request size with `socket.maxRequestBytes`. Dashboard views are `case`, `specification`, `question`, `stack`, `attempt`, `memory`, `classifier`, `feedback`, `usage`, `system`, `rollout`, and `evidence`.

Dashboard keys:

- `Tab`/right and `Shift-Tab`/left change views. `1` through `12` select the corresponding view.
- `j`/down and `k`/up select a case or attempt. `r` refreshes.
- `R` starts evidence reproduction for the selected case. `Enter` resumes it.
- `A` approves a specification, `q` approves a supervised quick-fix proposal, `f` requests changes, `c` reclassifies, `h` marks handled, `n` rejects, and `x`/`X` cancels.
- In Rollout, `o` selects `observe`, `s` selects `supervised`, and `p` selects `autonomous-pr`.
- In System, `e` toggles emergency stop. `Esc` or `Ctrl-C` closes the dashboard and returns to the normal editor.

## Rollout

`observe` ingests, deduplicates, classifies, correlates, learns from feedback, and produces private question briefs without code writes or external mutations. `supervised` runs investigators and planners but requires operator approval before each worker. `autonomous-pr` lets admitted quick fixes proceed through independent verification and ready-for-review PR creation. Specifications still require exact-version approval and merges remain human-only.

Start with `observe` for manual and Linear, then add Slack and Datadog. Promote only selected sources or repositories through the dashboard. A downgrade blocks new work. Emergency stop pauses or cancels active attempts and disables external mutations. Do not use an automatic success threshold for promotion.

## Evidence, backups, and restore

A verified fix requires a versioned evidence manifest tied to exact base and candidate SHAs. Commands record executable, argv, working directory, timeout, non-secret environment names, tool versions, expected and actual results, bounded output hashes, and artifact checksums. Bug evidence should fail on the base and pass on the candidate when practical. A separate verifier replays the manifest at exact commits. Failed or stale evidence produces `fail` or `needs-human`; confidence cannot override failed evidence. The PR body includes evidence and reproduction instructions. The dashboard `R` action and `evidence.reproduce` request create another verifier run without replacing prior results.

Backups use SQLite's online backup mechanism, run `PRAGMA integrity_check`, rename the completed snapshot atomically, and retain the configured number under `backup.directory`. If `backup.syncCommand` is configured, it is an argv array executed without a shell after the verified snapshot is complete. Synchronize only completed snapshots to local storage. Local sync is backup-only and may lag the remote authority.

Restore is explicit and loses changes newer than the selected snapshot:

1. Stop the controller and wait until `systemctl --user is-active background-agents-controller.service` is not `active`.
2. Confirm the snapshot is a verified SQLite file and preserve the current database as the `.replaced-...sqlite` file created by the restore operation.
3. Restore only while the controller is stopped. The implementation rejects restore while it is running, rechecks integrity, moves existing database/WAL/SHM files aside, installs the snapshot atomically, and keeps the replaced database.
4. Start the controller, inspect the dashboard, and reconcile source cursors, attempts, leases, Git worktrees, branches, PR heads, and external effects. Expect loss of events newer than the snapshot.

Rehearse backup, local synchronization, stop/restore/start, integrity checking, and post-restore reconciliation before enabling autonomous work. Do not copy a live SQLite database or its WAL/SHM files as a backup.

## Recovery and emergency stop

On restart, the controller queries durable attempts and systemd before replacing an attempt. It preserves dirty worktrees and starts a new generation from the latest trusted context when process state is uncertain. Provider exhaustion or stale usage checkpoints work and enters `paused-usage`; it does not start another attempt on that profile. Duplicate source delivery is expected and must collapse to one source event. Unknown external outcomes are reconciled before retrying.

Use the dashboard System view and `e`, or the socket `emergency.stop` request with `enabled: true`, to stop new scheduling and external mutations. Then stop the service when needed:

```sh
systemctl --user stop background-agents-controller.service
systemctl --user is-active background-agents-controller.service
```

Downgrade to `observe` or emergency-stop immediately on duplicate effects, isolation failure, verification bypass, classifier drift, stale usage, or failed restore rehearsal. Review and merge PRs manually only after the evidence and CI are independently satisfactory.

## Validation and smoke checks

From the repository root, these are the exact project checks:

```sh
npm run fmt:check
npm run typecheck
node --import tsx --test 'extensions/background-agents/**/*.test.ts'
npm test
```

For a deployed user service, use these exact checks:

```sh
systemd-run --version
systemd-run --user --pty --wait --collect --help
git --version
gh --version
gh stack --help
herdr --version
systemctl --user daemon-reload
systemctl --user restart background-agents-controller.service
systemctl --user is-active background-agents-controller.service
node --input-type=module <<'EOF'
import { connect } from "node:net";
const socket = process.env.PI_BACKGROUND_AGENTS_SOCKET ?? `${process.env.HOME}/.pi/agent/background-agents.sock`;
const request = JSON.stringify({ version: 1, id: `smoke-${Date.now()}`, type: "dashboard.get" }) + "\n";
const client = connect({ path: socket }, () => client.write(request));
client.setEncoding("utf8");
client.on("data", (data) => { process.stdout.write(data); client.end(); });
client.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
EOF
```

A complete AWS smoke run must also use a disposable test repository to verify two sequential verified draft PRs, `gh stack link`, individual `gh pr ready`, evidence reproduction, duplicate Slack acknowledgement, overlapping Linear/Datadog polling, provider exhaustion pause, restricted worktree writes, SQLite snapshot/sync/restore, and recovery after a failed unit or lost pane. No smoke test may merge a PR or send a Slack response.

## Operational caveats

This is accidental-damage isolation, not hostile-agent containment. Worktrees share `.git`, and incorrect path restrictions can damage refs or objects. Back up remote refs and serialize repository mutations. Slack and overlapping pollers are at-least-once delivery and require deduplication. Provider usage collection depends on provider APIs and stale usage must stop expensive scheduling. Prior-case memory can bias an investigation and must be revalidated against current evidence. `gh stack link` is additive, so the approved decomposition and bottom-to-top order must be frozen before submission. Restore can lose changes after the last snapshot. There is no web UI, public ingress, automatic merge, automatic question response, Linear issue creation, or Datadog mutation.
