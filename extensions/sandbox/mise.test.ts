import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { BashOperations, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { SandboxController } from "./controller.ts";
import { hasMiseConfig, withMise } from "./mise.ts";
import { createNativeSandboxTools } from "./native-tools.ts";

function project(t: TestContext): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-mise-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

function context(cwd: string): ExtensionToolContext {
	return {
		cwd,
		sessionManager: { getSessionId: () => "mise-test", getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;
}

function fakeMise(cwd: string, script?: string): string {
	const bin = join(cwd, "bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "mise"),
		script ??
			`#!/bin/bash
[[ "$1" == exec && "$2" == -- ]] || exit 99
shift 2
export PI_MISE_TEST="loaded 'value'"
exec "$@"
`,
		{ mode: 0o755 },
	);
	return bin;
}

test("projects without config keep commands unchanged", (t) => {
	const cwd = project(t);
	assert.equal(hasMiseConfig(cwd), false);
	const command = "printf '%s' \"$HOME\" | head -c 3";
	assert.equal(withMise(command, cwd, "/missing/shell"), command);
	// A directory named mise.toml is not a config.
	mkdirSync(join(cwd, "mise.toml"));
	assert.equal(hasMiseConfig(cwd), false);
});

for (const name of ["mise.toml", ".mise.toml", "mise.local.toml", ".mise.local.toml"]) {
	test(`detects ${name} in cwd and parents without caching`, (t) => {
		const cwd = project(t);
		const child = join(cwd, "nested", "project");
		mkdirSync(child, { recursive: true });
		assert.equal(hasMiseConfig(child), false);
		writeFileSync(join(cwd, name), "[env]\n");
		assert.equal(hasMiseConfig(cwd), true);
		assert.equal(hasMiseConfig(child), true);
		rmSync(join(cwd, name));
		assert.equal(hasMiseConfig(child), false);
	});
}

test("mise loads env before expansion and preserves shell syntax, cwd and exit status", (t) => {
	const cwd = project(t);
	writeFileSync(join(cwd, "mise.toml"), "[env]\n");
	const bin = fakeMise(cwd);
	const command = `printf '%s\\n' "$PI_MISE_TEST" | /usr/bin/tr a-z A-Z
printf '%s\\n' "$(pwd)"
cat <<'EOF'
literal '$PI_MISE_TEST' "quoted"
EOF
exit 17`;
	const result = spawnSync("/bin/bash", ["-c", withMise(command, cwd, "/bin/bash")], {
		cwd,
		env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
		encoding: "utf8",
	});
	assert.equal(result.status, 17);
	assert.equal(result.stdout, `LOADED 'VALUE'\n${cwd}\nliteral '$PI_MISE_TEST' "quoted"\n`);
});

test("mise failures do not fall back to executing the command", (t) => {
	const cwd = project(t);
	writeFileSync(join(cwd, "mise.toml"), "[env]\n");
	const bin = fakeMise(cwd, "#!/bin/bash\necho 'config is not trusted' >&2\nexit 42\n");
	for (const [path, expected] of [
		[bin, 42],
		[join(cwd, "missing"), 127],
	] as const) {
		const result = spawnSync("/bin/bash", ["-c", withMise("echo should-not-run", cwd)], {
			cwd,
			env: { ...process.env, PATH: path },
			encoding: "utf8",
		});
		assert.equal(result.status, expected);
		assert.equal(result.stdout, "");
	}
});

test("uses the configured shell even when its path contains spaces and quotes", (t) => {
	const cwd = project(t);
	writeFileSync(join(cwd, "mise.toml"), "[env]\n");
	const bin = fakeMise(cwd);
	const shell = join(cwd, "custom 'shell'");
	writeFileSync(shell, '#!/bin/bash\nexport PI_SHELL_TEST=custom\nexec /bin/bash "$@"\n', { mode: 0o755 });
	const result = spawnSync(
		"/bin/bash",
		["-c", withMise('printf "%s:%s" "$PI_SHELL_TEST" "$PI_MISE_TEST"', cwd, shell)],
		{
			cwd,
			env: { ...process.env, PATH: bin },
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "custom:loaded 'value'");
});

test("restricted native bash wraps after prefix injection and stays in sandbox operations", async (t) => {
	const cwd = project(t);
	writeFileSync(join(cwd, "mise.toml"), "[env]\n");
	let captured = "";
	const operations: BashOperations = {
		async exec(command, directory, options) {
			captured = command;
			assert.equal(directory, cwd);
			assert.equal(options.timeout, 5);
			options.onData(Buffer.from("sandboxed"));
			return { exitCode: 0 };
		},
	};
	const controller = { enforcing: true, bashOperations: () => operations } as unknown as SandboxController;
	const bash = createNativeSandboxTools(cwd, () => controller, {
		bash: { shellPath: "/bin/bash", commandPrefix: "export PREFIX=1" },
	}).find((tool) => tool.name === "bash")!;
	const command = 'eval "$(fnox export)"\nprintf "%s" "$PI_MISE_TEST"';
	await bash.execute("nested/1", { command, timeout: 5 }, undefined, undefined, context(cwd));
	assert.equal(captured, withMise(`export PREFIX=1\n${command}`, cwd, "/bin/bash"));
});

test("native bash with sandbox off uses mise and retains structured output", async (t) => {
	const cwd = project(t);
	writeFileSync(join(cwd, "mise.toml"), "[env]\n");
	const bin = fakeMise(cwd);
	const previous = process.env.PATH;
	process.env.PATH = `${bin}:/usr/bin:/bin`;
	t.after(() => {
		process.env.PATH = previous;
	});
	const controller = { enforcing: false } as SandboxController;
	const bash = createNativeSandboxTools(cwd, () => controller, {
		bash: { shellPath: "/bin/bash", commandPrefix: 'export PREFIX="$PI_MISE_TEST"' },
	}).find((tool) => tool.name === "bash")!;
	const result = await bash.execute(
		"direct",
		{ command: 'printf "%s" "$PREFIX"' },
		undefined,
		undefined,
		context(cwd),
	);
	const structured = result.structuredContent as Record<string, unknown>;
	assert.equal(structured.exit_code, 0);
	assert.equal(structured.output, "loaded 'value'");
	rmSync(join(cwd, "mise.toml"));
	const plain = await bash.execute(
		"without-mise",
		{ command: 'printf "%s" "${PREFIX:-plain}"' },
		undefined,
		undefined,
		context(cwd),
	);
	assert.equal((plain.structuredContent as Record<string, unknown>).output, "plain");
});
