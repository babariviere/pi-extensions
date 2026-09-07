# Spindle editing profile evaluation

This directory provides a dependency-free JSONL evaluator for controlled A/B runs of Spindle editing profiles. It reads one record per assigned task run, validates the complete version 1 shape, and writes a deterministic JSON summary. The checked-in `corpus.jsonl` is representative test data, not a benchmark result.

## Freeze the experiment before collection

Write an experiment manifest before collecting any run. Keep it beside the collected JSONL or in the system that produces it. Pin all of the following:

1. **Model identity:** provider, API, exact model ID or immutable revision, inference settings, and any provider feature flags.
2. **Prompt:** exact system, developer, and task prompt text for each variant. Prefer content hashes plus checked-in source paths. Record which Spindle edit profile each variant selects.
3. **Repository fixture:** repository revision, clean working-copy state, runtime and package-manager versions, installed dependency lockfile, and the reset command used before every run.
4. **Assignment:** the complete task-to-variant assignment, run order, retry policy, and random seed if assignment or ordering is randomized. A `variant` plus `task` pair must be unique in one input file, so repeated trials need distinct task IDs.
5. **Scoring:** evaluator implementation and revision, acceptance tests or rubric, tie and partial-credit rules, timeout, and the procedure for resolving ambiguous outcomes.

Do not change any pinned item after collection starts. If one changes, start a new experiment.

`passed` is supplied by the pinned evaluator. It is never inferred from Spindle's overall outcome or from whether individual tools succeeded. For example, the sandbox-denial records in the representative corpus pass because the evaluator expects the unsafe operation to be denied, while their Spindle outcome and scripted route are failures.

## JSONL record format

Each nonblank line is one JSON object:

```json
{"version":1,"variant":"control","task":"create-001","passed":true,"metrics":{"version":1,"profile":"anthropic","routes":{"edit":{"attempts":0,"successes":0,"failures":0},"write":{"attempts":1,"successes":1,"failures":0},"applyPatch":{"attempts":0,"successes":0,"failures":0},"scripted":{"attempts":0,"successes":0,"failures":0}},"knownFiles":["src/new.ts"],"repeatedAttempts":[],"guardRefusals":0,"durationMs":800,"outcome":"succeeded"},"toolCalls":3,"tokens":{"input":2200,"output":410}}
```

Fields:

- `version` must be `1`.
- `variant` is the pinned A/B assignment label.
- `task` is the stable task-run identifier.
- `passed` is the external evaluator's Boolean decision.
- `metrics` is the version 1 `SpindleEditMetricsV1` value from `spindle_exec` result details.
- `toolCalls` is an optional non-negative integer for all tool calls in the run.
- `tokens` is an optional pair of non-negative integer `input` and `output` token counts.

Validation rejects unknown fields, malformed route counts, unsorted or duplicate path aggregates, duplicate variant/task assignments, and inputs that do not contain exactly two variants. Optional usage measurements may be omitted per record. Their summaries include `measuredRuns`, and a comparison delta is emitted only when both variants have that measurement.

## Default decision protocol

Unless an experiment manifest predeclares a different powered design, collect at least 30 independent runs per corpus task and variant. Use task pass rate as the primary outcome. Do not adopt a candidate when any task category regresses by more than 5 percentage points or when the aggregate pass rate is lower. When aggregate pass rates differ by less than 2 percentage points, require at least a 10% reduction in one predeclared secondary cost metric, such as failed edit attempts, excess retries, tool calls, tokens, or duration, without a 10% regression in another predeclared cost metric. Treat smaller samples and the checked-in representative records as pipeline checks only, not evidence for selecting a default.

Run order should be randomized or counterbalanced, and repeated trials need distinct task IDs. Report per-task results in addition to the aggregate so a high-volume easy task cannot hide a regression on recovery or sandbox cases.

## Run

From the repository root:

```sh
npm run spindle:evaluate -- extensions/spindle/evaluation/corpus.jsonl --baseline edit-first
```

Use `-` as the path to read JSONL from standard input. `--baseline` is optional. Without it, the lexicographically first variant is the baseline. The output always lists baseline first and reports normalized deltas as candidate minus baseline.

The summary includes task pass rate, route attempts and failures, guard refusals, repeated-edit attempts, known-file counts, duration, and optional tool-call and token totals and means. Counts are derived only from supplied records. Rates, means, and deltas are rounded to six decimal places. Record ordering does not affect output.
