import assert from "node:assert/strict";
import { test } from "node:test";
import { parseResults } from "./kagi.ts";

const FIXTURE = `<!doctype html><html><body>
  <div class="search-result _0_SRI">
    <a class="__sri_title_link" href="https://example.com/page">Example Title</a>
    <div class="__sri-desc">First snippet description.</div>
  </div>
  <div class="search-result">
    <a class="title-link" href="https://kagi.com/redirect?url=https%3A%2F%2Ftarget.com%2Fx">Wrapped Title</a>
    <div class="sri-desc">Second snippet.</div>
  </div>
  <div class="search-result">
    <a class="__sri_title_link" href="https://example.com/page">Duplicate URL</a>
    <div class="__sri-desc">Should be deduped.</div>
  </div>
</body></html>`;

test("parseResults extracts title, url, and snippet", () => {
	const results = parseResults(FIXTURE);
	assert.ok(results.length >= 1);
	assert.deepEqual(results[0], {
		title: "Example Title",
		url: "https://example.com/page",
		snippet: "First snippet description.",
	});
});

test("parseResults unwraps kagi.com redirect wrappers", () => {
	const results = parseResults(FIXTURE);
	const wrapped = results.find((r) => r.title === "Wrapped Title");
	assert.ok(wrapped, "wrapped result should be present");
	assert.equal(wrapped?.url, "https://target.com/x");
});

test("parseResults dedupes repeated urls", () => {
	const results = parseResults(FIXTURE);
	const urls = results.map((r) => r.url);
	assert.equal(new Set(urls).size, urls.length);
});

test("parseResults returns nothing for markup without results", () => {
	assert.deepEqual(parseResults("<html><body><p>no results</p></body></html>"), []);
});
