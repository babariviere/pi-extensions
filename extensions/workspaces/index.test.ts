import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isManagedWorkspaceDir, isValidName, listWorkspaces, parseHerdrWorkspaces, resolveRepo } from "./index.ts";

function fakeJj(reply: (args: string[]) => { code: number; stdout: string; stderr: string }): ExtensionAPI {
	return {
		exec: async (command: string, args: string[]) => {
			assert.equal(command, "jj");
			assert.deepEqual(args.slice(0, 2), ["--color", "never"]);
			assert.ok(args.includes("--ignore-working-copy"), "inspection must not snapshot the checkout");
			return reply(args.slice(2).filter((arg) => arg !== "--ignore-working-copy"));
		},
	} as unknown as ExtensionAPI;
}

function success(stdout: string) {
	return { code: 0, stdout, stderr: "" };
}

function missingPath(name: string) {
	return { code: 1, stdout: "", stderr: `Error: Workspace has no recorded path: ${name}` };
}

test("isValidName accepts safe names, rejects the rest", () => {
	assert.ok(isValidName("feature-x"));
	assert.ok(isValidName("feat_1.2"));
	assert.ok(!isValidName("has space"));
	assert.ok(!isValidName("a/b"));
	assert.ok(!isValidName(""));
});

test("parseHerdrWorkspaces tolerates field-name variation", () => {
	assert.deepEqual(parseHerdrWorkspaces(undefined), []);

	const fromWorkspaces = parseHerdrWorkspaces({
		workspaces: [
			{ id: "w1", cwd: "/a", label: "api" },
			{ workspace_id: "w2", path: "/b" },
			{ id: "w3" }, // no cwd -> dropped
		],
	});
	assert.deepEqual(fromWorkspaces, [
		{ id: "w1", cwd: "/a", label: "api" },
		{ id: "w2", cwd: "/b", label: undefined },
	]);

	const fromList = parseHerdrWorkspaces({ list: [{ workspaceId: "x", working_directory: "/c" }] });
	assert.deepEqual(fromList, [{ id: "x", cwd: "/c", label: undefined }]);
});

for (const pointerKind of ["relative", "absolute"] as const) {
	test(`resolveRepo resolves ${pointerKind} .jj/repo pointers from .jj`, async () => {
		const root = mkdtempSync(join(tmpdir(), "workspace-repo-"));
		try {
			const main = join(root, "source", "my-repo");
			const workspace = join(root, "managed", "my-repo", "feature");
			mkdirSync(join(main, ".jj", "repo"), { recursive: true });
			mkdirSync(join(workspace, ".jj"), { recursive: true });
			const repoPath = join(main, ".jj", "repo");
			const pointer = pointerKind === "absolute" ? repoPath : relative(join(workspace, ".jj"), repoPath);
			writeFileSync(join(workspace, ".jj", "repo"), `${pointer}\n`);
			const pi = fakeJj((args) => {
				assert.deepEqual(args, ["workspace", "root"]);
				return success(`${workspace}\n`);
			});
			assert.deepEqual(await resolveRepo(pi, workspace), {
				workspaceRoot: workspace,
				mainRoot: main,
				repoName: "my-repo",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("resolveRepo keeps the store-owning workspace as mainRoot", async () => {
	const root = mkdtempSync(join(tmpdir(), "workspace-main-"));
	try {
		mkdirSync(join(root, ".jj", "repo"), { recursive: true });
		const repo = await resolveRepo(
			fakeJj(() => success(root)),
			root,
		);
		assert.equal(repo.mainRoot, root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listWorkspaces uses recorded paths and identifies current by path, not basename", async () => {
	const repo = { workspaceRoot: "/external/checkout-name", mainRoot: "/src/project", repoName: "project" };
	const paths: Record<string, string> = {
		default: repo.mainRoot,
		"jj-name": repo.workspaceRoot,
		"checkout-name": "/somewhere/else",
	};
	const pi = fakeJj((args) => {
		if (args[1] === "list") return success("default: abc\njj-name: def\ncheckout-name: ghi\n");
		assert.deepEqual(args.slice(0, 3), ["workspace", "root", "--name"]);
		return success(`${paths[args[3]]}\n`);
	});
	assert.deepEqual(
		await listWorkspaces(pi, { root: "/managed", copyFiles: [] }, repo, "/external/checkout-name/subdir"),
		[
			{ name: "default", current: false, dir: repo.mainRoot },
			{ name: "jj-name", current: true, dir: repo.workspaceRoot },
			{ name: "checkout-name", current: false, dir: "/somewhere/else" },
		],
	);
});

test("listWorkspaces falls back only for legacy workspaces without recorded paths", async () => {
	const repo = { workspaceRoot: "/old-location/feature", mainRoot: "/src/project", repoName: "project" };
	const pi = fakeJj((args) =>
		args[1] === "list" ? success("default: abc\nfeature: def\nother: ghi\n") : missingPath(args[3]),
	);
	assert.deepEqual(await listWorkspaces(pi, { root: "/managed", copyFiles: [] }, repo, repo.workspaceRoot), [
		{ name: "default", current: false, dir: repo.mainRoot },
		{ name: "feature", current: true, dir: repo.workspaceRoot },
		{ name: "other", current: false, dir: "/managed/project/other" },
	]);
});

test("recorded current workspace takes precedence over the legacy basename guess", async () => {
	const repo = { workspaceRoot: "/external/feature", mainRoot: "/src/project", repoName: "project" };
	const pi = fakeJj((args) => {
		if (args[1] === "list") return success("feature: abc\nactual-name: def\n");
		return args[3] === "feature" ? missingPath("feature") : success(repo.workspaceRoot);
	});
	const entries = await listWorkspaces(pi, { root: "/managed", copyFiles: [] }, repo, repo.workspaceRoot);
	assert.deepEqual(
		entries.filter((entry) => entry.current).map((entry) => entry.name),
		["actual-name"],
	);
	assert.equal(entries[0].dir, "/managed/project/feature");
});

test("listWorkspaces recognizes canonical aliases of the current workspace", async () => {
	const root = mkdtempSync(join(tmpdir(), "workspace-alias-"));
	try {
		const workspace = join(root, "actual");
		const alias = join(root, "alias");
		mkdirSync(workspace);
		symlinkSync(workspace, alias);
		const repo = { workspaceRoot: alias, mainRoot: "/src/project", repoName: "project" };
		const pi = fakeJj((args) => success(args[1] === "list" ? "different-name: abc\n" : workspace));
		const entries = await listWorkspaces(pi, { root: "/managed", copyFiles: [] }, repo, alias);
		assert.equal(entries[0].current, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listWorkspaces does not guess paths after unrelated lookup failures", async () => {
	const repo = { workspaceRoot: "/src/project", mainRoot: "/src/project", repoName: "project" };
	const pi = fakeJj((args) =>
		args[1] === "list" ? success("feature: abc\n") : { code: 1, stdout: "", stderr: "Permission denied" },
	);
	await assert.rejects(
		listWorkspaces(pi, { root: "/managed", copyFiles: [] }, repo, repo.workspaceRoot),
		/Permission denied/,
	);
});

test("recorded paths outside the managed directory are not eligible for removal", () => {
	assert.equal(isManagedWorkspaceDir("/managed/project", "/managed/project/feature"), true);
	for (const path of ["/external/feature", "/managed/project-other/feature", "/managed/project", "/managed"]) {
		assert.equal(isManagedWorkspaceDir("/managed/project", path), false, path);
	}
});
