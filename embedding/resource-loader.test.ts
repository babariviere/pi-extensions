import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { EmbeddedResourceLoader, ownedExtension } from "./resource-loader.mjs";
import { PILOT_EXTENSION_NAMES, PILOT_PROFILE_PATH } from "./profile.mjs";

test("profile loads the selected tools without terminal-only or orchestration extensions", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-profile-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const loader = new EmbeddedResourceLoader(
		{
			cwd: root,
			agentDir: root,
			settingsManager: SettingsManager.inMemory(),
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
		},
		{ requiredPaths: [PILOT_PROFILE_PATH], ownedPackages: {} },
	);
	await loader.reload();
	const result = loader.getExtensions();
	assert.deepEqual(result.errors, []);
	assert.deepEqual(PILOT_EXTENSION_NAMES, [
		"sandbox",
		"apply-patch",
		"web",
		"browser",
		"todos",
		"usage",
		"jobs",
		"subagents",
	]);
	const commands = result.extensions.flatMap((extension) => [...extension.commands.keys()]);
	assert.ok(commands.includes("sandbox"));
	assert.ok(!commands.some((command) => ["night", "workspace", "autofix", "linear", "context"].includes(command)));
});

test("known package copies are filtered before imports, unrelated entries survive reload and project trust", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "embedded-loader-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "source");
	const agentDir = join(root, "agent");
	const pkg = join(root, "personal-copy");
	const marker = join(root, "must-not-run");
	await mkdir(join(pkg, "extensions", "jobs"), { recursive: true });
	await mkdir(join(pkg, "extensions", "optional"));
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({ name: "shared-tools", pi: { extensions: ["extensions/*/index.ts"] } }),
	);
	const duplicate = join(pkg, "extensions", "jobs", "index.ts");
	await writeFile(
		duplicate,
		`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export default () => { throw new Error('duplicate'); };`,
	);
	await symlink(duplicate, join(agentDir, "extensions", "renamed.ts"));
	await writeFile(
		join(pkg, "extensions", "optional", "index.ts"),
		`export default pi => pi.registerCommand('optional', { description: 'kept', handler: async () => {} });`,
	);
	const project = join(cwd, ".pi", "extensions", "project.ts");
	await writeFile(
		project,
		`export default pi => pi.registerCommand('project', { description: 'trusted', handler: async () => {} });`,
	);
	const required = join(root, "required.ts");
	await writeFile(
		required,
		`export default pi => pi.registerCommand('required', { description: 'first', handler: async () => {} });`,
	);
	const settings = SettingsManager.inMemory({ packages: [pkg] });
	const ownership = { "shared-tools": ["extensions/jobs"] };
	assert.equal(ownedExtension(duplicate, ownership), true);
	assert.equal(ownedExtension(join(agentDir, "extensions", "renamed.ts"), ownership), true);
	assert.equal(ownedExtension(project, ownership), false);
	const loader = new EmbeddedResourceLoader(
		{
			cwd,
			agentDir,
			settingsManager: settings,
			additionalExtensionPaths: [duplicate],
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
		},
		{ requiredPaths: [required], ownedPackages: ownership },
	);
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.deepEqual(
		loader
			.getExtensions()
			.extensions.flatMap((extension) => [...extension.commands.keys()])
			.sort(),
		["optional", "required"],
	);
	await assert.rejects(readFile(marker), { code: "ENOENT" });
	assert.deepEqual(settings.getGlobalSettings().packages, [pkg], "personal settings are untouched");
	await writeFile(
		required,
		`export default pi => pi.registerCommand('required', { description: 'reloaded', handler: async () => {} });`,
	);
	await loader.reload();
	assert.equal(
		loader
			.getExtensions()
			.extensions.find((extension) => extension.commands.has("required"))
			?.commands.get("required")?.description,
		"reloaded",
	);
	await assert.rejects(readFile(marker), { code: "ENOENT" });
	const trusted = new EmbeddedResourceLoader(
		{
			cwd,
			agentDir,
			settingsManager: settings,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
		},
		{ requiredPaths: [required], ownedPackages: ownership, projectTrusted: true },
	);
	await trusted.reload();
	assert.deepEqual(trusted.getExtensions().errors, []);
	assert.ok(trusted.getExtensions().extensions.some((extension) => extension.commands.has("project")));
	assert.equal(
		trusted.getExtensions().extensions.find((extension) => extension.commands.has("optional"))?.sourceInfo.scope,
		"user",
	);
});

test("missing required extension is a startup error, not a silent fallback", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "embedded-missing-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const loader = new EmbeddedResourceLoader(
		{ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(), noExtensions: true },
		{ requiredPaths: [join(root, "missing.ts")], ownedPackages: {} },
	);
	await loader.reload();
	assert.ok(loader.getExtensions().errors.length > 0);
});
