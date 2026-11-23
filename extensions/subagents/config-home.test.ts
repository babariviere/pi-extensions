import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareConfigHome } from "./config-home.ts";

test("prepareConfigHome copies the dirs that get written to and links the rest", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-config-home-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const source = join(dir, "config");
	mkdirSync(join(source, "jj"), { recursive: true });
	mkdirSync(join(source, "gh"), { recursive: true });
	writeFileSync(join(source, "jj", "config.toml"), "[user]\nname = 'dev'\n");
	writeFileSync(join(source, "gh", "hosts.yml"), "github.com:\n");

	const destination = join(dir, "sandbox.agents", "xdg");
	const prepared = prepareConfigHome(destination, { source });

	assert.equal(prepared.path, destination);
	assert.deepEqual(prepared.problems, []);
	// jj is a real copy: it is the directory jj writes its per-repo record into,
	// and writing through a link would land outside the run's writable roots.
	assert.equal(lstatSync(join(destination, "jj")).isSymbolicLink(), false);
	assert.match(readFileSync(join(destination, "jj", "config.toml"), "utf-8"), /name = 'dev'/);
	assert.equal(
		readFileSync(join(destination, "jj", "conf.d", "zz-pi-sandbox.toml"), "utf-8"),
		'[signing]\nbehavior = "drop"\n',
	);
	// Everything else keeps working, without becoming writable.
	assert.equal(lstatSync(join(destination, "gh")).isSymbolicLink(), true);
	assert.match(readFileSync(join(destination, "gh", "hosts.yml"), "utf-8"), /github.com/);

	// The copy is independent of the real config home.
	writeFileSync(join(destination, "jj", "config.toml"), "changed");
	assert.match(readFileSync(join(source, "jj", "config.toml"), "utf-8"), /name = 'dev'/);
});

test("prepareConfigHome does nothing when the tool it exists for is unconfigured", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-config-home-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const source = join(dir, "empty-config");
	mkdirSync(source, { recursive: true });
	const prepared = prepareConfigHome(join(dir, "xdg"), { source });
	assert.equal(prepared.path, undefined);
	assert.deepEqual(prepared.problems, []);
	assert.equal(existsSync(join(dir, "xdg")), false);
});
