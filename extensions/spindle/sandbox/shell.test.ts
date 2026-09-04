import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resolveShellPath, shellQuote } from "./shell.ts";

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "seatbelt-shell-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("falls back to /bin/bash when settings.json is missing", () => {
	assert.equal(resolveShellPath(), "/bin/bash");
});

test("falls back to /bin/bash when settings.json is unparsable junk", () => {
	writeFileSync(join(agentDir, "settings.json"), "{not json");
	assert.equal(resolveShellPath(), "/bin/bash");
});

test("falls back to /bin/bash when shellPath is missing or blank", () => {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: "  " }));
	assert.equal(resolveShellPath(), "/bin/bash");
});

test("honours PI_CODING_AGENT_DIR and a configured shellPath", () => {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: "/opt/homebrew/bin/bash" }));
	assert.equal(resolveShellPath(), "/opt/homebrew/bin/bash");
});

test("shellQuote round trips a value with quotes and spaces through bash -c", () => {
	const tricky = 'it\'s a "tricky" value with spaces';
	const output = execFileSync("bash", ["-c", `printf '%s' ${shellQuote(tricky)}`], { encoding: "utf8" });
	assert.equal(output, tricky);
});

test("shellQuote round trips a path containing a single quote", () => {
	const tricky = "/tmp/it's a dir/file";
	const output = execFileSync("bash", ["-c", `printf '%s' ${shellQuote(tricky)}`], { encoding: "utf8" });
	assert.equal(output, tricky);
});
