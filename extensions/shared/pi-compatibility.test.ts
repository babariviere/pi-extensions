import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("every packaged entry point loads through the native Pi extension loader", async () => {
	const extensionsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const paths = readdirSync(extensionsDir)
		.map((name) => join(extensionsDir, name, "index.ts"))
		.filter((path) => existsSync(path));
	const cwd = mkdtempSync(join(tmpdir(), "pi-compatibility-"));
	const agentDir = join(cwd, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousRefKey = process.env.PI_SECRETS_REF_KEY;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		// Loading factories does not start a session or make model/tool requests.
		const loaded = await discoverAndLoadExtensions(paths, cwd, agentDir);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, paths.length);
		assert.ok(loaded.extensions.some((extension) => extension.path.endsWith("router/index.ts")));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousRefKey === undefined) delete process.env.PI_SECRETS_REF_KEY;
		else process.env.PI_SECRETS_REF_KEY = previousRefKey;
		rmSync(cwd, { recursive: true, force: true });
	}
});
