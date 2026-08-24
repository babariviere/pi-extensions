# secrets extension

Manages secrets in pi sessions. It sources secret values from the [fnox](https://github.com/fnox-dev/fnox) CLI and automatically injects them into bash commands, replaces them in tool output with reversible references, and tells the LLM which secrets are available by name.

Pattern-based detection runs independently of fnox, so recognized secret formats (GitHub tokens, API keys, JWTs, AWS keys, etc.) are always removed from tool output even if fnox is not installed.

## Secret references

A secret value never reaches the model. What it sees instead is a reference:

```
<secret:github-token:9f2c4ab1>
```

The id is `HMAC-SHA256(session key, value)` truncated to 8 hex chars (longer if two values ever collide), so the same value always yields the same reference and two different tokens of the same kind yield different ones. The type hint (`github-token`) is cosmetic: it is derived the same way for fnox secrets and for pattern-detected ones, and lookup is by id alone.

References expand again on the way in:

| tool | behavior |
|------|----------|
| `write` | `content` is expanded to real values |
| `edit` | `oldText` and `newText` are expanded, so an edit matches what is actually on disk |
| `bash` | rewritten to `${NAME}`, never to a value, because a value on a command line lands in the process table and the shell history. Refused inside single quotes, where the expansion would be literal text |
| code tools (`spindle_exec`) | passed through untouched; the nested `write` it performs is hydrated on its own `tool_call` |
| everything else | refused; a reference copied into a URL or an MCP argument is inert |

This is what makes read-modify-write safe. Reading a `.env`, editing one line, and writing it back preserves every other secret in the file, because the model only ever handled references.

To place a secret the model has never seen into a file, it writes `<secret:NAME>` using a name from the system-prompt list. To write a literal reference (a template for some other tool), escape it: `<\secret:NAME>`.

Reference-shaped text already present in a file is escaped on the way out, so rewriting a file that contains a placeholder reproduces the placeholder instead of planting a credential.

Transcribing a partial mask into a `write` or `edit` is blocked rather than repaired, since it always means the real value is being destroyed.

### Security model

Cooperative, not adversarial. Anything that can run bash can exfiltrate anything the process can reach. References prevent accidents: a masked value transcribed back into a config file, a secret persisted to a session transcript, a token echoed into context. The one adversarial property they do carry is per-tool scoping, which blocks placeholder transplant (copying a reference into an HTTP tool to move a value the model never saw).

Known gaps:

- Values transformed before printing (hex, gzip, a JWT signed with the secret) are not detected.
- The session key is exported as `PI_SECRETS_REF_KEY` so subagents parse parent references. Every child process sees it, so treat it as a session identifier rather than a secret: it does not resolve a reference on its own, since hydration only expands ids this session minted.
- Subagents inherit the key but not the values behind detected references; a child re-derives fnox secrets on its own and refuses what it cannot resolve.
- Per-chunk scrubbing of streamed `!` output is not implemented; only agent tool results are covered.
- A grep or diff gutter (`path:line:`, `+`) prevents the env-assignment layer from matching, so a secret detected only by its variable name can still appear in that output.

## Features

- **Injection** — prepends `eval "$(fnox export)"` to every bash tool call so secrets are available as env vars without hardcoding values
- **`!` command injection** — also injects secrets into user `!` commands (respects `shellPath` from pi's `settings.json`)
- **Output scrubbing** — replaces secrets in all tool results (bash, read, grep, etc.), including the `details` persisted to session files, using four layers:
  1. Exact fnox secret values
  2. 34 recognized provider patterns (GitHub, OpenAI, Anthropic, Stripe, AWS, Slack, GitLab, Google, etc.)
  3. URL-embedded secrets (`user:pass@host`, sensitive query params)
  4. `NAME=VALUE` env-var assignments with sensitive names

  Every layer mints a reversible reference, so scrubbing is idempotent and round-trips through `write`/`edit`.
- **Reference expansion** — expands references back to values in `write` and `edit`, to `${NAME}` in `bash`, and nowhere else
- **System prompt injection** — appends the list of available secret names to the system prompt so the LLM can reference them without knowing their values
- **`/secret-list` command** — lists all loaded secret names (never values) and the fnox config path

## Requirements

- [fnox](https://github.com/fnox-dev/fnox) CLI in `$PATH` for secret injection (optional — pattern-based masking works without it)
- A `fnox.toml` somewhere in the project directory tree (fnox is searched upward from cwd)

## Install

```bash
pi install git:github.com/babariviere/pi-extensions
```

Or copy the `extensions/secrets/` directory to `~/.pi/agent/extensions/secrets/`.

## Usage

Once installed, secrets load automatically at session start. In bash commands, reference secrets by name:

```bash
curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user
```

The LLM also knows which secret names are available (injected into the system prompt), so you can instruct it naturally:

> "Use $GITHUB_TOKEN to call the GitHub API"

### `/secret-list`

Lists the loaded secret names and the fnox config file being used:

```
secrets (from fnox.toml in /your/project):
  • GITHUB_TOKEN
  • DATABASE_URL
  • STRIPE_SECRET_KEY
```

## Reference format

Every secret, fnox-backed or pattern-detected, appears in tool output the same way:

```
<secret:github-token:9f2c4ab1>
<secret:github-token:33be07d5>
<secret:database-url:0e5177bc>
<secret:pem-private-key:7d1e90c4>
```

The legacy partial masking remains in `secret-mask.ts` and is used only when no reference registry is supplied.

## Caching

Secrets are cached for 30 seconds to avoid repeated `fnox export` calls. The cache refreshes automatically on the next tool call after expiry.

## Supported pattern types

The pattern matcher covers 34 formats:

| Provider | Formats |
|----------|---------|
| Anthropic | API keys, admin keys |
| OpenAI | Legacy and modern project/service-account keys |
| GitHub | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, fine-grained PATs |
| GitLab | PATs, pipeline trigger tokens, runner tokens, OAuth secrets |
| AWS | Access key IDs, secret access keys (keyword-gated) |
| Slack | Bot, user, app-level, config, refresh tokens, webhooks |
| Google | OAuth access/refresh tokens, client secrets, API keys |
| Stripe | Secret, restricted, publishable, webhook signing keys |
| SendGrid | API keys |
| npm | Granular access tokens |
| Hugging Face | Tokens |
| Twilio | Account SIDs, API key SIDs |
| JWT | Three-segment base64url tokens |
| PEM | Private key blocks (reversible, like every other match) |
| HTTP headers | `Authorization`, `x-api-key`, `x-auth-token` bearer tokens |
| URLs | Userinfo passwords, sensitive query params |
| Env vars | `NAME=VALUE` assignments with sensitive names |
