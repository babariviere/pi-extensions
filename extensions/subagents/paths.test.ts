import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeSegment } from "./paths.ts";

test("sanitizeSegment preserves safe ASCII names", () => {
	for (const value of ["agent", "TODO-123", "parent_session", "model.v1", "A-Z_0.9-", "-name", "_name"]) {
		assert.equal(sanitizeSegment(value), value);
	}
});

test("sanitizeSegment replaces separators, whitespace, Unicode and control characters", () => {
	for (const [value, expected] of [
		["parent/child", "parent_child"],
		["parent\\child", "parent_child"],
		["agent name:\t\n", "agent_name___"],
		["café", "caf_"],
		["a\0b", "a_b"],
	]) {
		assert.equal(sanitizeSegment(value), expected);
	}
});

test("sanitizeSegment replaces leading dots and supplies a nonempty fallback", () => {
	for (const [value, expected] of [
		["", "_"],
		[".", "_"],
		["..", "_"],
		["...hidden", "_hidden"],
		["../escape", "__escape"],
		["../../escape", "__.._escape"],
	]) {
		assert.equal(sanitizeSegment(value), expected);
	}
});

test("sanitizeSegment bounds the sanitized segment to 128 characters", () => {
	assert.equal(sanitizeSegment("a".repeat(128)), "a".repeat(128));
	assert.equal(sanitizeSegment("a".repeat(129)), "a".repeat(128));
	assert.equal(sanitizeSegment("/".repeat(200)), "_".repeat(128));
	assert.equal(sanitizeSegment(".".repeat(200)), "_");
});

test("sanitizeSegment always returns a stable single safe segment", () => {
	for (const value of ["", ".", "..", "../a", "a/b", "a\\b", "/absolute", "C:\\temp", "\0", "你好", "x".repeat(200)]) {
		const result = sanitizeSegment(value);
		assert.match(result, /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/);
		assert.equal(sanitizeSegment(result), result);
	}
});
