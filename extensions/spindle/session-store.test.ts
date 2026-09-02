import assert from "node:assert/strict";
import { test } from "node:test";

import { SpindleSessionStore } from "./session-store.ts";

test("a value survives round-tripping through JSON", () => {
	const store = new SpindleSessionStore();
	const write = store.set("index", { files: ["a.ts", "b.ts"], count: 2 });
	assert.equal(write.key, "index");
	assert.equal(write.replaced, false);
	assert.deepEqual(write.keys, ["index"]);
	const read = store.get("index");
	assert.equal(read.found, true);
	assert.deepEqual(read.value, { files: ["a.ts", "b.ts"], count: 2 });
	assert.equal(read.bytes, write.bytes);
	// A second write to the same key reports that it replaced one.
	assert.equal(store.set("index", { files: [] }).replaced, true);
});

test("a miss is distinguishable from a stored null", () => {
	const store = new SpindleSessionStore();
	store.set("nothing", null);
	assert.deepEqual(store.get("nothing"), { key: "nothing", found: true, bytes: 4, value: null });
	assert.deepEqual(store.get("absent"), { key: "absent", found: false });
});

test("a stored value is a snapshot, not a live reference", () => {
	const store = new SpindleSessionStore();
	const source = { items: [1] };
	store.set("snapshot", source);
	source.items.push(2);
	assert.deepEqual((store.get("snapshot").value as { items: number[] }).items, [1]);
});

test("delete and clear keep the byte accounting honest", () => {
	const store = new SpindleSessionStore();
	store.set("a", "x".repeat(100));
	store.set("b", "y".repeat(100));
	assert.equal(store.size, 2);
	const deleted = store.delete("a");
	assert.equal(deleted.deleted, true);
	assert.deepEqual(deleted.keys, ["b"]);
	assert.equal(store.bytes, 102);
	assert.equal(store.delete("a").deleted, false);
	assert.deepEqual(store.clear(), { cleared: 1 });
	assert.equal(store.bytes, 0);
	assert.equal(store.size, 0);
});

test("undefined and functions are refused, and say what to do instead", () => {
	const store = new SpindleSessionStore();
	assert.throws(() => store.set("k", undefined), /cannot store undefined/);
	assert.throws(() => store.set("k", () => 1), /cannot store undefined/);
	assert.equal(store.size, 0);
});

test("a cyclic value is refused instead of crashing the program", () => {
	const store = new SpindleSessionStore();
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	assert.throws(() => store.set("k", cyclic), /JSON-serializable/);
});

test("keys are validated", () => {
	const store = new SpindleSessionStore();
	assert.throws(() => store.set("", 1), /non-empty string key/);
	assert.throws(() => store.set(42, 1), /non-empty string key/);
	assert.throws(() => store.set("has space", 1), /is not allowed/);
	assert.throws(() => store.set("x".repeat(200), 1), /longer than/);
});

test("limits throw and name what is held, rather than evicting", () => {
	const store = new SpindleSessionStore({ maxKeys: 2, maxTotalBytes: 350, maxValueBytes: 200 });
	store.set("a", "x".repeat(100));
	store.set("b", "y".repeat(100));
	assert.throws(() => store.set("c", 1), /limit of 2 keys \(a, b\)/);
	assert.throws(() => store.set("a", "z".repeat(500)), /over the 200 B per-key limit/);
	// Replacing an existing key releases its bytes first.
	store.set("a", "z".repeat(190));
	assert.throws(() => store.set("b", "z".repeat(190)), /over its 350 B session limit/);
	assert.equal(store.size, 2);
});

test("preview is a bounded slice of the stored JSON, and only for held keys", () => {
	const store = new SpindleSessionStore();
	store.set("small", { n: 1 });
	store.set("big", "x".repeat(1000));
	assert.equal(store.preview("small"), '{"n":1}');
	assert.equal(store.preview("big", 20)?.length, 20);
	assert.ok(store.preview("big", 20)?.endsWith("\u2026"));
	assert.equal(store.preview("absent"), undefined);
});

test("describe summarizes what a result envelope should echo", () => {
	const store = new SpindleSessionStore();
	store.set("small", "x".repeat(10));
	store.set("big", "y".repeat(4096));
	assert.equal(store.describe(), "small (12 B), big (4.0 KB)");
});
