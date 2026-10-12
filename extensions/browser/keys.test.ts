import assert from "node:assert/strict";
import { test } from "node:test";
import { parseKey } from "./keys.ts";

test("parseKey handles named keys and aliases", () => {
	assert.deepEqual(parseKey("Enter"), { key: "Enter", code: "Enter", keyCode: 13, modifiers: 0, text: "\r" });
	assert.equal(parseKey("esc").key, "Escape");
	assert.equal(parseKey("pagedown").key, "PageDown");
	assert.deepEqual(parseKey("Space"), { key: " ", code: "Space", keyCode: 32, modifiers: 0, text: " " });
});

test("parseKey handles characters and modifiers", () => {
	assert.deepEqual(parseKey("a"), { key: "a", code: "KeyA", keyCode: 65, modifiers: 0, text: "a" });
	assert.deepEqual(parseKey("Shift+a"), { key: "A", code: "KeyA", keyCode: 65, modifiers: 8, text: "A" });
	// Command modifiers suppress text insertion.
	assert.deepEqual(parseKey("Control+Shift+k"), { key: "K", code: "KeyK", keyCode: 75, modifiers: 10 });
	assert.equal(parseKey("Meta+Enter").text, undefined);
	assert.equal(parseKey("+").key, "+");
	assert.equal(parseKey("7").code, "Digit7");
});

test("parseKey rejects unknown keys and modifiers", () => {
	assert.throws(() => parseKey("Hyper+a"), /Unknown modifier/);
	assert.throws(() => parseKey("F13"), /Unknown key/);
});
