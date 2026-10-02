# Local Clef classifier

Registers **`clef/clef-flash-4bit`** by default, backed by
[`mlx-community/clef-flash-4bit`](https://huggingface.co/mlx-community/clef-flash-4bit),
the Apache-2.0, 9B Clef Flash decision model quantized to 4-bit for Apple Silicon.
The full 27B Clef model is an optional configuration choice.
It answers Pi's `choice`, `bool`, and `score` questions about text/JSON state.
It is not a chat model and does not appear in `/model` or change your chat model.
LM Studio is not used: ordinary chat generation skips Clef's classification head.

## Readiness checks and installation

Requires Apple Silicon macOS and Python 3.11+ on PATH. Session startup checks the
Python environment and cached checkpoint offline, without installing or downloading
anything. Ready environments stay silent. If something is missing or broken, Pi
shows a warning directing you to **`/clef install`**. There is no Clef footer status.
Extension discovery alone does not start processes or download anything.

If the configured Python already provides `mlx`, `mlx-vlm`, and `huggingface_hub`,
it is reused. Otherwise, `/clef install` creates an isolated virtualenv at
`~/.local/share/pi-clef/venv` and installs `mlx-vlm` and `huggingface_hub` there.
It never installs packages into your system or configured Python environment.
Concurrent Pi sessions serialize virtualenv creation and installation.

Running `/clef install` permits Python package installation and downloading the
configured checkpoint from Hugging Face. The loader is executable code supplied
by the model repository and runs with host permissions. Review its `clef_mlx.py`
before enabling the extension. The default snapshot is pinned to
`d9ec324f7992383bdfb7a0b4eed8b4b9d10f81be`, not the mutable `main` branch.
Missing checkpoints are downloaded once into the standard Hugging Face cache
(roughly **6.2 GB of weights** for Flash, plus metadata and cache storage).
Cached checkpoints are reused without network access. Interrupted downloads can
resume on retry. A configured `modelPath` is validated locally instead of downloaded.

No configuration is required. Optional settings go in `<agent-dir>/clef.json`
(normally `~/.pi/agent/clef.json`):

```json
{
  "model": "flash",
  "python": "python3",
  "idleTimeoutMs": 600000,
  "requestTimeoutMs": 180000,
  "maxLength": 8192,
  "memoryLimitGB": 16
}
```

The extension loads through the package manifest, or directly with
`pi -e ./extensions/clef/index.ts`. Use `/reload` after configuration changes.
Session startup does not wait for the readiness check. `/clef status` shows state;
`/clef install` prepares the environment and checkpoint or retries a failed install.
`/clef setup` remains an alias for `/clef install`. Classification shares preparation
and waits for it before its inference deadline begins, but never initiates installation
or downloads itself. Readiness checks have a 30-second limit; installation has a
separate one-hour limit. Readiness issues are warnings and do not prevent Pi from starting.
Weights are loaded only on classification. Inference remains offline and does
not download or install anything. Prepopulate the virtualenv and pinned cache
before starting Pi to use Clef without setup network access.

## Use from native codemode

Enable codemode in Pi's `settings.json` if needed:

```json
{ "defaultTools": ["+codemode"] }
```

```js
const clef = await models.getModelOfType("classifier", "clef", "clef-flash-4bit");
if (!clef) throw new Error("Load the clef extension first");
const result = await models.classify(clef, {
  state: { message: "The checkout is down for all customers." },
  questions: {
    urgent: {
      type: "bool",
      instructions: "Does this need immediate attention?",
      criteria: { true: "Service outage or blocked customers", false: "Nonurgent request" }
    },
    team: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: { engineering: "Bugs and outages", billing: "Invoices and payments" }
    }
  }
});
return result.stopReason === "stop" ? result.answers : { error: result.errorMessage };
```

Other extensions can use `ctx.modelRegistry.findOfType("classifier", "clef", "clef-flash-4bit")`
and `ctx.modelRegistry.classify(model, context, { signal: ctx.signal })`.
This does not automatically wire Clef into the deterministic `router` extension.

## Configuration and commands

Personal configuration merges with **trusted** project `.pi/clef.json`.
Unknown settings and invalid values fail explicitly; configuration errors never
fall back to a different interpreter or model.

| Setting | Default | Meaning |
| --- | --- | --- |
| `model` | `"flash"` | `"flash"` registers `clef/clef-flash-4bit`; `"full"` registers `clef/clef-4bit` instead. Only the configured model is advertised. |
| `python` | `python3` | Python 3.11+ executable on PATH or absolute path, used for setup and reused for inference if dependencies are present. Otherwise inference uses the managed virtualenv. `~/` expands. No shell command or argument string. |
| `modelPath` | Pinned Hugging Face cache snapshot | Optional absolute directory containing this model's weights and trusted `clef_mlx.py`. `~/` expands. Local paths bypass revision verification. |
| `idleTimeoutMs` | `600000` | Unload ten minutes after the last completed call. Integer, 1 to 86400000. |
| `requestTimeoutMs` | `180000` | Deadline including queue wait and cold loading, after environment/checkpoint preparation. Integer, 1 to 3600000. |
| `maxLength` | `8192` | Total state plus schema token limit, 128 to 16384. Oversized input fails, never silently truncates. |
| `memoryLimitGB` | `16` for Flash, `24` for full | MLX allocation limit in GiB, integer, 4 to 128. Not a total-process or OS memory cap. |

- `/clef` or `/clef status`: show worker state and limits without loading weights.
- `/clef install`: install missing Python dependencies and download the pinned checkpoint, without loading weights.
- `/clef setup`: compatibility alias for `/clef install`.
- `/clef unload`: cancel checks/installation and active/queued calls, and release the worker. Installed packages and downloaded weights remain cached. The next call checks readiness and reloads as needed.

### Optional full model

For higher overall benchmark quality at the expense of memory and latency,
set `"model": "full"`, remove any explicit Flash `modelPath`, and either remove
`memoryLimitGB` to use the full-model default (24 GiB), or set it explicitly.
After reload, run `/clef install` to prepare the full model's snapshot pinned to
`a1cc3c6d04beed778adbd53bad8899f91d3c0968` (roughly **16.3 GB of weights**).

Then use the classifier ID `clef-4bit` instead of `clef-flash-4bit`. A custom
`modelPath` must contain the model selected by `model`, including its loader.

## Lifecycle, probabilities, and caveats

- The first call starts a Python subprocess and loads the checkpoint. Calls are
  serialized, with at most 16 waiting calls per Pi session. A loaded worker is
  reused until idle unloading, explicit unloading, session shutdown, or reload.
- Active cancellation or timeout terminates the worker, escalating to SIGKILL
  after one second if needed. Queued cancellation leaves active inference alone.
  A replacement waits for the old process to exit. Interrupted calls are never
  automatically retried. Each Pi session has its own worker, not a shared daemon.
- Questions are scored jointly by the custom head, without generating text.
  `bool` maps to the checkpoint's `noul` type. Choice confidence is the highest
  option probability; score is the expected zero-based level, with the highest
  level probability as confidence. Temperature divides logits before softmax.
  These probabilities are not guarantees of correctness.
- Text/JSON only, at most 100 questions and 256 criteria per question. This
  integration does not accept image/video attachments, despite the model's
  multimodal capabilities. Transport requests/responses are limited to 4 MiB.
- Token usage is reported with zero monetary cost. HTTP headers, `fetch`,
  `onResponse`, retry settings, and per-request environment overrides do not
  apply to this stdio provider. `onPayload` receives Pi's public classifier context;
  its replacement is validated before transport.
- On **36 GB unified memory**, Flash's ~6.2 GB of weights leave more headroom than
  the full model's ~16.3 GB, but activations, MLX, macOS, and other applications
  still need memory. The defaults are a starting point, not a fit guarantee.
  Be careful simultaneously loading a large LM Studio model or running multiple
  Clef sessions. Reduce `maxLength` if memory is tight.
- No listener, API credential, or persistent background service. `/clef install`
  uses network access only for missing packages/checkpoints and overrides inherited
  Hub offline flags for that purpose. Session shutdown or unload terminates setup
  and its subprocesses. Inference's offline flags disable standard Hub downloads;
  trusted checkpoint code and Python dependencies still execute with host
  permissions, outside the shell sandbox. They are not network-isolated by the OS.
  State is sent over local pipes, not intentionally persisted or logged. Library
  diagnostics are drained rather than exposed in classifier errors.

## Verification

```sh
node --import tsx --test 'extensions/clef/*.test.ts'
python3 -B extensions/clef/worker_test.py
python3 -B extensions/clef/setup_test.py
npm run typecheck
npm test
```

Tests use fake workers and mocked Python setup/protocol checks. They do not download
weights or prove end-to-end inference performance. Run the codemode example after
`/clef install` completes to verify the actual MLX runtime and available memory on your Mac.
