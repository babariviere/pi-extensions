import assert from "node:assert/strict";
import { test } from "node:test";
import { readFlagArgument } from "./argv-flag.ts";

test("readFlagArgument accepts both --flag value and --flag=value", () => {
	const flag = "code-mode-sandbox";
	assert.equal(readFlagArgument(flag, ["pi", "--code-mode-sandbox", "read-only"]), "read-only");
	assert.equal(readFlagArgument(flag, ["pi", "--code-mode-sandbox=read-only"]), "read-only");
	assert.equal(readFlagArgument(flag, ["pi", "--other", "x"]), undefined);
	// A bare flag must not swallow the next flag as its value.
	assert.equal(readFlagArgument(flag, ["pi", "--code-mode-sandbox", "--no-skills"]), undefined);
	assert.equal(readFlagArgument(flag, ["pi", "--code-mode-sandbox"]), undefined);
});

test("readFlagArgument takes the last occurrence of a repeated flag", () => {
	const flag = "code-mode-sandbox";
	assert.equal(
		readFlagArgument(flag, ["pi", "--code-mode-sandbox", "full", "--code-mode-sandbox", "read-only"]),
		"read-only",
	);
	assert.equal(readFlagArgument(flag, ["pi", "--code-mode-sandbox=full", "--code-mode-sandbox=off"]), "off");
});
