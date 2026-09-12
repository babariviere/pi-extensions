import assert from "node:assert/strict";
import { test } from "node:test";

import { guestPolyfillPlan, selectGuestPolyfills } from "./guest-polyfills.ts";
import { QuickJsRuntime } from "./quickjs-runtime.ts";

const unexpectedHostCall = async () => {
	throw new Error("unexpected host call");
};

const baseOptions = {
	timeoutMs: 10_000,
	memoryLimitBytes: 32 * 1024 * 1024,
};

const run = async (code: string): Promise<unknown> => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(code, unexpectedHostCall, baseOptions);
	assert.equal(result.terminationReason, "completed", result.error ?? "");
	return result.value;
};

const failure = async (code: string): Promise<string> => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(code, unexpectedHostCall, baseOptions);
	assert.equal(result.terminationReason, "runtime_error");
	return result.error ?? "";
};

test("only the polyfills a program mentions are injected", () => {
	assert.deepEqual(selectGuestPolyfills("return 1 + 1;").length, 0);
	assert.deepEqual(guestPolyfillPlan("return 1 + 1;").source, "");
	assert.deepEqual(guestPolyfillPlan("new TextEncoder().encode('a')").names, ["textCodec"]);
	assert.deepEqual(guestPolyfillPlan("new URL('http://a/b').pathname").names, ["url"]);
	assert.deepEqual(guestPolyfillPlan("btoa('a')").names, ["base64"]);
});

test("a program that needs nothing gets no polyfill globals", async () => {
	const value = await run(
		"return ['Text' + 'Encoder', 'U' + 'RL', 'at' + 'ob'].filter((name) => typeof globalThis[name] !== 'undefined');",
	);
	assert.deepEqual(value, []);
});

test("entropy is injected only for the crypto polyfill", () => {
	assert.equal(guestPolyfillPlan("crypto.randomUUID()").needsEntropy, true);
	assert.equal(guestPolyfillPlan("new URL('http://a')").needsEntropy, false);
});

test("queueMicrotask runs before a resolved timer", async () => {
	const value = await run(
		[
			"const order = [];",
			"await new Promise((resolve) => { queueMicrotask(() => { order.push('micro'); resolve(undefined); }); });",
			"order.push('after');",
			"return order;",
		].join("\n"),
	);
	assert.deepEqual(value, ["micro", "after"]);
});

test("performance.now advances from a zero origin", async () => {
	const value = await run("return [performance.now() >= 0, typeof performance.timeOrigin];");
	assert.deepEqual(value, [true, "number"]);
});

test("base64 round-trips and rejects non-Latin-1 input", async () => {
	assert.equal(await run("return btoa('hello');"), "aGVsbG8=");
	assert.equal(await run("return btoa('hi');"), "aGk=");
	assert.equal(await run("return atob('aGVsbG8=');"), "hello");
	assert.equal(await run("return atob(btoa('a\\u00ff!'));"), "a\u00ff!");
	assert.match(await failure("return btoa('\\u4e2d');"), /outside the Latin-1 range/);
	assert.match(await failure("return atob('a@bc');"), /bad character/);
});

test("TextEncoder and TextDecoder round-trip utf-8", async () => {
	assert.deepEqual(await run("return Array.from(new TextEncoder().encode('hi'));"), [104, 105]);
	assert.deepEqual(await run("return Array.from(new TextEncoder().encode('\\u00e9'));"), [195, 169]);
	assert.deepEqual(await run("return Array.from(new TextEncoder().encode('\\u4e2d'));"), [228, 184, 173]);
	// Astral plane: a surrogate pair must encode as one four-byte sequence.
	assert.deepEqual(await run("return Array.from(new TextEncoder().encode('\\ud83d\\ude00'));"), [240, 159, 152, 128]);
	assert.equal(await run("return new TextEncoder().encoding;"), "utf-8");
	assert.equal(
		await run("return new TextDecoder().decode(new TextEncoder().encode('a\\u00e9\\u4e2d\\ud83d\\ude00'));"),
		"a\u00e9\u4e2d\ud83d\ude00",
	);
});

test("an unpaired surrogate encodes as U+FFFD", async () => {
	assert.deepEqual(await run("return Array.from(new TextEncoder().encode('\\ud800'));"), [239, 191, 189]);
});

test("TextDecoder replaces malformed bytes and honours fatal", async () => {
	assert.equal(await run("return new TextDecoder().decode(new Uint8Array([0xff, 0x61]));"), "\ufffda");
	assert.match(
		await failure("return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff]));"),
		/not valid utf-8/,
	);
	assert.match(await failure("return new TextDecoder('latin1');"), /utf-8 only/);
	assert.match(await failure("return new TextDecoder().decode(new Uint8Array([97]), { stream: true });"), /streaming/);
});

test("TextDecoder strips a BOM unless ignoreBOM is set", async () => {
	assert.equal(await run("return new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf, 97]));"), "a");
	assert.equal(
		await run(
			"return new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 97])).length;",
		),
		2,
	);
});

test("TextDecoder accepts an ArrayBuffer and a view with an offset", async () => {
	assert.equal(await run("return new TextDecoder().decode(new Uint8Array([97, 98]).buffer);"), "ab");
	assert.equal(
		await run("return new TextDecoder().decode(new Uint8Array(new Uint8Array([97, 98, 99]).buffer, 1, 2));"),
		"bc",
	);
});

test("structuredClone preserves what JSON drops", async () => {
	const value = await run(
		[
			"const source = { when: new Date(0), pattern: /a/gi, set: new Set([1, 2]), map: new Map([['k', 1]]), bytes: new Uint8Array([1, 2]) };",
			"const copy = structuredClone(source);",
			"return [",
			"  copy.when instanceof Date && copy.when.getTime() === 0,",
			"  copy.pattern instanceof RegExp && copy.pattern.flags === 'gi',",
			"  copy.set instanceof Set && copy.set.has(2),",
			"  copy.map instanceof Map && copy.map.get('k') === 1,",
			"  copy.bytes instanceof Uint8Array && copy.bytes[1] === 2,",
			"  copy.when !== source.when,",
			"];",
		].join("\n"),
	);
	assert.deepEqual(value, [true, true, true, true, true, true]);
});

test("structuredClone handles cycles and rejects functions", async () => {
	assert.equal(
		await run(
			"const node = { name: 'a' }; node.self = node; const copy = structuredClone(node); return copy.self === copy;",
		),
		true,
	);
	assert.match(await failure("return structuredClone({ run: () => 1 });"), /function could not be cloned/);
	assert.match(await failure("return structuredClone(Promise.resolve(1));"), /Promise could not be cloned/);
});

test("crypto.randomUUID is a well-formed v4 UUID and varies", async () => {
	const value = await run("return [crypto.randomUUID(), crypto.randomUUID()];");
	const [first, second] = value as [string, string];
	assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.notEqual(first, second);
});

test("crypto.getRandomValues fills the view and validates its type", async () => {
	assert.equal(await run("const view = new Uint8Array(8); crypto.getRandomValues(view); return view.length;"), 8);
	assert.equal(await run("const view = new Uint32Array(4); return crypto.getRandomValues(view) === view;"), true);
	assert.match(await failure("return crypto.getRandomValues(new Float64Array(2));"), /integer typed array/);
});

test("the entropy pool is finite and says so when drained", async () => {
	const message = await failure(
		"for (let i = 0; i < 5000; i++) crypto.getRandomValues(new Uint8Array(64)); return 'never';",
	);
	assert.match(message, /entropy pool \(4096 bytes\) is exhausted/);
	assert.match(message, /pi\.bash/);
});

test("URL parses and exposes the standard parts", async () => {
	const value = await run(
		[
			"const url = new URL('https://user:pw@Example.COM:8443/a/b/../c?x=1&y=2#frag');",
			"return [url.protocol, url.username, url.password, url.hostname, url.port, url.host, url.pathname, url.search, url.hash, url.origin, url.href];",
		].join("\n"),
	);
	assert.deepEqual(value, [
		"https:",
		"user",
		"pw",
		"example.com",
		"8443",
		"example.com:8443",
		"/a/c",
		"?x=1&y=2",
		"#frag",
		"https://example.com:8443",
		"https://user:pw@example.com:8443/a/c?x=1&y=2#frag",
	]);
});

test("URL drops a default port and keeps a non-default one", async () => {
	assert.equal(await run("return new URL('https://a.test:443/x').href;"), "https://a.test/x");
	assert.equal(await run("return new URL('http://a.test:80/x').port;"), "");
	assert.equal(await run("return new URL('http://a.test:8080/x').port;"), "8080");
});

test("URL resolves relative references against a base", async () => {
	const cases: Array<[string, string]> = [
		["c", "https://a.test/x/c"],
		["/c", "https://a.test/c"],
		["../c", "https://a.test/c"],
		["?q=1", "https://a.test/x/b?q=1"],
		["#h", "https://a.test/x/b#h"],
		["//other.test/z", "https://other.test/z"],
		["https://b.test/z", "https://b.test/z"],
	];
	for (const [input, expected] of cases) {
		assert.equal(
			await run(`return new URL(${JSON.stringify(input)}, 'https://a.test/x/b').href;`),
			expected,
			`resolving ${input}`,
		);
	}
});

test("URL rejects malformed input", async () => {
	assert.match(await failure("return new URL('not a url').href;"), /Invalid URL/);
	assert.match(await failure("return new URL('https://a.test:99999/').href;"), /not a valid port/);
	assert.match(await failure("return new URL('https:///x').href;"), /missing host/);
});

test("an opaque URL keeps its path and reports a null origin", async () => {
	const value = await run("const url = new URL('mailto:a@b.test'); return [url.protocol, url.pathname, url.origin];");
	assert.deepEqual(value, ["mailto:", "a@b.test", "null"]);
});

test("a file URL parses with an empty host", async () => {
	const value = await run(
		"const url = new URL('file:///tmp/x.txt'); return [url.protocol, url.hostname, url.pathname, url.origin];",
	);
	assert.deepEqual(value, ["file:", "", "/tmp/x.txt", "null"]);
});

test("an IPv6 host round-trips", async () => {
	const value = await run("const url = new URL('http://[::1]:8080/x'); return [url.hostname, url.port, url.href];");
	assert.deepEqual(value, ["[::1]", "8080", "http://[::1]:8080/x"]);
});

test("URL setters rewrite href", async () => {
	const value = await run(
		[
			"const url = new URL('https://a.test/x?q=1#h');",
			"url.pathname = 'y/z';",
			"url.hash = 'other';",
			"url.search = 'a=2';",
			"url.port = '9000';",
			"return [url.href, url.searchParams.get('a')];",
		].join("\n"),
	);
	assert.deepEqual(value, ["https://a.test:9000/y/z?a=2#other", "2"]);
});

test("searchParams edits write back through to href", async () => {
	const value = await run(
		[
			"const url = new URL('https://a.test/x');",
			"url.searchParams.set('b', '2');",
			"url.searchParams.append('a', '1');",
			"url.searchParams.append('a', '3');",
			"const before = url.href;",
			"url.searchParams.delete('a');",
			"return [before, url.href, url.searchParams.size];",
		].join("\n"),
	);
	assert.deepEqual(value, ["https://a.test/x?b=2&a=1&a=3", "https://a.test/x?b=2", 1]);
});

test("URLSearchParams covers the query API", async () => {
	const value = await run(
		[
			"const params = new URLSearchParams('a=1&b=2&a=3');",
			"const all = params.getAll('a');",
			"params.set('a', '9');",
			"const entries = [...params];",
			"params.sort();",
			"return [all, params.get('a'), params.has('b'), params.has('b', '5'), entries.length, params.toString(), [...params.keys()]];",
		].join("\n"),
	);
	assert.deepEqual(value, [["1", "3"], "9", true, false, 2, "a=9&b=2", ["a", "b"]]);
});

test("URLSearchParams encodes form bodies the urlencoded way", async () => {
	assert.equal(
		await run("return new URLSearchParams({ q: 'a b&c=d', keep: '*' }).toString();"),
		"q=a+b%26c%3Dd&keep=*",
	);
	assert.equal(await run("return new URLSearchParams('q=a+b%26c').get('q');"), "a b&c");
	assert.equal(await run("return new URLSearchParams([['a', '1'], ['a', '2']]).getAll('a').join(',');"), "1,2");
});
