import assert from "node:assert/strict";
import { test } from "node:test";
import { readFlagArgument } from "./argv-flag.ts";

test("readFlagArgument accepts both --flag value and --flag=value", () => {
	const flag = "spindle-sandbox";
	assert.equal(readFlagArgument(flag, ["pi", "--spindle-sandbox", "read-only"]), "read-only");
	assert.equal(readFlagArgument(flag, ["pi", "--spindle-sandbox=read-only"]), "read-only");
	assert.equal(readFlagArgument(flag, ["pi", "--other", "x"]), undefined);
	// A bare flag must not swallow the next flag as its value.
	assert.equal(readFlagArgument(flag, ["pi", "--spindle-sandbox", "--no-skills"]), undefined);
	assert.equal(readFlagArgument(flag, ["pi", "--spindle-sandbox"]), undefined);
});

test("readFlagArgument takes the last occurrence of a repeated flag", () => {
	const flag = "spindle-sandbox";
	assert.equal(
		readFlagArgument(flag, ["pi", "--spindle-sandbox", "full", "--spindle-sandbox", "read-only"]),
		"read-only",
	);
	assert.equal(readFlagArgument(flag, ["pi", "--spindle-sandbox=full", "--spindle-sandbox=off"]), "off");
});
