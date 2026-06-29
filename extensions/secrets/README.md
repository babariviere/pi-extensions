# secrets extension

Manages secrets in pi sessions. It sources secret values from the [fnox](https://github.com/fnox-dev/fnox) CLI and automatically injects them into bash commands, scrubs them from tool output, and tells the LLM which secrets are available by name.

Pattern-based masking runs independently of fnox, so recognized secret formats (GitHub tokens, API keys, JWTs, AWS keys, etc.) are always redacted from tool output even if fnox is not installed.

## Features

- **Injection** — prepends `eval "$(fnox export)"` to every bash tool call so secrets are available as env vars without hardcoding values
- **`!` command injection** — also injects secrets into user `!` commands (respects `shellPath` from pi's `settings.json`)
- **Output scrubbing** — scrubs all tool results (bash, read, grep, etc.) using four layers:
  1. Exact fnox secret values (partial mask: `[NAME: prefix****suffix]`)
  2. 34 recognized provider patterns (GitHub, OpenAI, Anthropic, Stripe, AWS, Slack, GitLab, Google, etc.)
  3. URL-embedded secrets (`user:pass@host`, sensitive query params)
  4. `NAME=VALUE` env-var assignments with sensitive names
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

## Masking format

Fnox secrets appear in tool output as:

```
[GITHUB_TOKEN: ghp_ab****ef]
```

Pattern-matched secrets (without fnox) use a shorter form:

```
ghp_ab****ef
```

PEM private keys are fully redacted:

```
[REDACTED: PEM PRIVATE KEY]
```

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
| PEM | Private key blocks (full redaction) |
| HTTP headers | `Authorization`, `x-api-key`, `x-auth-token` bearer tokens |
| URLs | Userinfo passwords, sensitive query params |
| Env vars | `NAME=VALUE` assignments with sensitive names |
