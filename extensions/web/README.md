# Web

One direct tool, `web`, searches Kagi or fetches content. There are no legacy tool aliases.

```js
const links = await tools.web({ action: "search", query: "pi extensions", limit: 5 });
const page = await tools.web({ action: "fetch", url: links.results[0].url, timeout: 30000 });
```

## Migration

Replace `web_search({ query, limit })` with `web({ action: "search", query, limit })`, and
`fetch_content({ url, timeout })` with `web({ action: "fetch", url, timeout })`. The old names are not
registered as aliases. In codemode scripts, use `tools.web(...)`; outputs retain their existing shapes.

## Actions

| Action | Required | Optional | Structured output |
| --- | --- | --- | --- |
| `search` | `query` | `limit` (1–20, default 10) | `{ query, results: [{ title, url, snippet }], error? }` |
| `fetch` | `url` | `timeout` (milliseconds, minimum 1000, default 30000) | `{ url, text, source?, title?, date?, contentType?, status?, repositoryPath?, error? }` |

The selected action's required arguments are checked before execution. The action does not add a wrapper or
discriminator to outputs. Errors keep their structured data and set Pi's `isError` flag, so codemode scripts can
inspect `error` and HTTP `status`.

Search returns ranked Markdown links and snippets. Fetch clones and summarizes GitHub repository URLs
(root, tree, or blob), directly fetches `raw.githubusercontent.com`, and converts other pages to Markdown with
Defuddle. Blocked or empty pages can fall back to a headed browser via CDP. Conclusive HTTP errors and short
not-found placeholders remain errors rather than usable page content.

### Browser fallback

The fallback drives the first installed Chromium browser, in this order: Helium, Google Chrome, Chromium.
It runs as a separate instance with a dedicated profile under
`${XDG_CACHE_HOME:-~/.cache}/pi-web-extension/<browser>-profile`, so it never touches your everyday
browser session. The instance stays warm on the CDP port between fetches.

It is designed to stay out of sight:

- On macOS it launches in the background and hidden (`open -g -j -n`).
- It starts with no window (`--no-startup-window`).
- Pages are CDP *hidden targets*, which never appear in a tab strip or window and close with the session.

While a page shows a bot-protection interstitial (such as Cloudflare's "Just a moment..."), the fetch keeps
waiting for it to resolve, and the reported status is that of the page that replaces the challenge.

A browser already listening on the CDP port is reused as is, so an older Chrome instance started by a
previous version keeps being used until it quits.

Model-facing fetched text is capped at 2000 lines or 50 KB. When truncated, the full content is saved to a temp
file and its path is included in the output. Codemode receives the full structured `text`. Interactive output
keeps its folded preview, expansion support, and human-only fetch source label.

## Credentials, configuration, and permissions

Set `KAGI_SESSION_TOKEN` through the environment, `~/.pi/agent/secrets.json`, or the secrets extension.
Run `/kagi-status` to validate the token. This command is unchanged.

Defaults live in [`settings.ts`](./settings.ts), including search limits, fetch and clone timeouts, repository
summary sizes, and browser fallback settings. Browser fallback defaults to enabled, with a 45-second timeout
and CDP port 9333. No new configuration keys are introduced.

Search is read-only. Fetch can write clone caches, temporary Markdown files, and a browser profile, and can
launch a headed browser. Because Pi exposes one annotation set per tool, `web` conservatively advertises
`readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, and `openWorldHint: true`.
The existing secrets and sandbox policies still apply to tool calls, including calls made through codemode.
