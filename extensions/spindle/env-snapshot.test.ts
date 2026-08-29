import assert from "node:assert/strict";
import { test } from "node:test";

import { spindleProcessSnapshot } from "./env-snapshot.ts";

test("allowlists exact keys and prefix families, skips everything else", () => {
	const snapshot = spindleProcessSnapshot("/session/cwd", {
		HOME: "/home/user",
		USER: "user",
		LOGNAME: "user",
		SHELL: "/bin/bash",
		PATH: "/usr/bin",
		LANG: "en_US.UTF-8",
		LC_ALL: "C",
		XDG_CONFIG_HOME: "/home/user/.config",
		TERM: "xterm-256color",
		TMPDIR: "/tmp",
		OPENROUTER_API_KEY: "sk-or-secret",
		GITHUB_TOKEN: "ghp_secret",
		EMPTY: "",
	});
	assert.deepEqual(snapshot.env, {
		HOME: "/home/user",
		USER: "user",
		LOGNAME: "user",
		SHELL: "/bin/bash",
		LANG: "en_US.UTF-8",
		TERM: "xterm-256color",
		TMPDIR: "/tmp",
		PATH: "/usr/bin",
		LC_ALL: "C",
		XDG_CONFIG_HOME: "/home/user/.config",
		// PWD follows the agent session, not the host launch directory.
		PWD: "/session/cwd",
	});
});

test("exposes host platform facts and the session cwd", () => {
	const snapshot = spindleProcessSnapshot("/session");
	assert.equal(snapshot.platform, process.platform);
	assert.equal(snapshot.arch, process.arch);
	assert.equal(snapshot.cwd, "/session");
});

test("undefined and empty values are dropped", () => {
	const snapshot = spindleProcessSnapshot("/c", {
		HOME: "/h",
		USER: undefined,
		LC_CTYPE: "",
	});
	assert.deepEqual(snapshot.env, { HOME: "/h", PWD: "/c" });
});
