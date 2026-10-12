# Browser

One direct tool, `browser`, lets the agent drive a real browser: open pages, read them, click, type, and take
screenshots. Use `web` to simply read a page; use `browser` when a page needs interaction.

```js
const page = await tools.browser({ action: "open", url: "https://httpbin.org/forms/post" });
const name = page.snapshot.elements.find((el) => el.role === "textbox");
await tools.browser({ action: "type", pageId: page.pageId, ref: name.ref, text: "Ada", snapshot: false });
const shot = await tools.browser({ action: "screenshot", pageId: page.pageId });
image(shot.image);
```

## Actions

`pageId` is optional everywhere and defaults to the most recently used page.

| Action | Required | Optional | Does |
| --- | --- | --- | --- |
| `open` | `url` | `snapshot`, `maxChars` | Open a new page (bare hosts get `https://`). |
| `navigate` | `url` | | Load a URL in an existing page. |
| `snapshot` | | `maxChars` | Read the page: capped text plus numbered interactive elements. |
| `click` | `ref` | | Click an element from the latest snapshot. |
| `type` | `ref`, `text` | `clear` (default true), `submit` | Type into a field, or pick an option in a `<select>`. |
| `press` | `key` | | Press a key: `Enter`, `Escape`, `Tab`, `ArrowDown`, `a`, `Control+a`, ... |
| `scroll` | | `direction`, `amount`, `ref` | Scroll the page, or scroll an element into view. |
| `back` | | | Go back in the page's history. |
| `eval` | `expression` | | Run JavaScript in the page; promises are awaited. |
| `screenshot` | | `fullPage` | Capture the viewport (1280x800) or the whole page (capped at 10,000 px). |
| `list` | | | List this session's open pages. |
| `close` | | | Close a page. |
| `show` | | | Bring the browser on screen at that page, to watch or help (e.g. a CAPTCHA). |
| `hide` | | | Hide the browser again. |

Page-changing actions (`open`, `navigate`, `snapshot`, `click`, `type`, `press`, `scroll`, `back`) return a
fresh snapshot unless `snapshot: false`. Element refs are reassigned on every snapshot and navigation, so always
use refs from the latest one. Codemode scripts receive the structured result, including `snapshot.elements`, `value`
for `eval`, and an `image` block for `screenshot` that `image()` can display.

JavaScript dialogs are accepted automatically and reported in `dialogs`. Popups (`target=_blank` links and forms,
`window.open`) load in the same tab. If something still opens a new tab, it is registered as a page and reported in
`newPages`.

## Browser instance and visibility

The tool shares the background browser used by the `web` fetch fallback: the first installed of Helium, Google
Chrome, or Chromium, running as a separate instance with its own profile under
`${XDG_CACHE_HOME:-~/.cache}/pi-web-extension/<browser>-profile` and CDP port 9333. Your everyday browser and its
sessions are never touched. The profile is persistent, so cookies survive between sessions.

Pages are ordinary tabs in that instance, which runs hidden. Nothing appears on screen until `show`. `hide` minimizes
the agent's windows and hides the app again; minimizing matters because macOS un-hides an app that has been shown
once when it creates a new tab.

## Lifetime

Pages stay open between calls. A page closes on `close`, after 15 idle minutes, or at session end. The browser
itself stays running, warm for the next call. If the pi process dies without a clean shutdown, its tabs remain in the
background browser until it quits.

Defaults (port, viewport, timeouts, snapshot caps, idle timeout) live in [`settings.ts`](./settings.ts).

## Permissions

There are no approval prompts. The tool can reach any http(s), `file:` or `about:` URL, including localhost, and runs
arbitrary JavaScript in pages through `eval`. It is meant for browsing, not for logging into accounts.
