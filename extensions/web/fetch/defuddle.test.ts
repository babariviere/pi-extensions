import assert from "node:assert/strict";
import { test } from "node:test";
import { DefuddleError, defuddleFetch, extractMarkdown } from "./defuddle.ts";

const FIXTURE_HTML = `<!doctype html><html lang="en"><head>
<title>Fixture Article</title>
<meta property="article:published_time" content="2024-01-02T00:00:00Z">
</head><body><article>
<h2>Hello There</h2>
<p>This is the first paragraph of the article body, long enough to be scored as
the main content of the page during extraction rather than discarded as noise.</p>
<p>A second paragraph reinforces that this block is the primary readable content
and should survive defuddle's low-score removal pass.</p>
</article></body></html>`;

test("extractMarkdown pulls title and markdown body from HTML (offline)", async () => {
	const r = await extractMarkdown(FIXTURE_HTML, "https://example.com/post");
	assert.match(r.title ?? "", /Fixture Article/);
	assert.match(r.markdown, /Hello There/);
	assert.match(r.markdown, /first paragraph/);
});

test("defuddleFetch maps HTTP errors to DefuddleError", async () => {
	const orig = globalThis.fetch;
	globalThis.fetch = async () => new Response("forbidden", { status: 403 });
	try {
		await assert.rejects(
			() => defuddleFetch("https://example.com/x", { timeout: 5000 }),
			(e) => e instanceof DefuddleError && /HTTP 403/.test(e.message),
		);
	} finally {
		globalThis.fetch = orig;
	}
});

test("defuddleFetch returns non-HTML bodies verbatim", async () => {
	const orig = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response('{"a":1}', { status: 200, headers: { "content-type": "application/json" } });
	try {
		const r = await defuddleFetch("https://example.com/data.json", { timeout: 5000 });
		assert.equal(r.markdown, '{"a":1}');
		assert.match(r.contentType ?? "", /application\/json/);
	} finally {
		globalThis.fetch = orig;
	}
});

test("defuddleFetch maps aborts to a timeout message", async () => {
	const orig = globalThis.fetch;
	globalThis.fetch = async () => {
		const e = new Error("aborted");
		e.name = "AbortError";
		throw e;
	};
	try {
		await assert.rejects(
			() => defuddleFetch("https://example.com/x", { timeout: 5000 }),
			(e) => e instanceof DefuddleError && /Timed out/.test(e.message),
		);
	} finally {
		globalThis.fetch = orig;
	}
});

test("defuddleFetch refuses non-http schemes and internal hosts before fetching", async () => {
	const orig = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("network must not be reached for blocked URLs");
	};
	try {
		for (const url of [
			"http://169.254.169.254/latest/meta-data/",
			"http://localhost:8080/",
			"http://127.0.0.1/",
			"http://10.0.0.1/",
			"file:///etc/passwd",
			"ftp://example.com/x",
		]) {
			await assert.rejects(
				() => defuddleFetch(url, { timeout: 5000 }),
				(e) => e instanceof DefuddleError,
				`expected ${url} to be rejected`,
			);
		}
	} finally {
		globalThis.fetch = orig;
	}
});
