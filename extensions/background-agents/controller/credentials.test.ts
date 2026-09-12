import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { readSecureCredentialText } from "./credentials.ts";

test("secure credentials accept 0400 and 0600 regular files", () => {
	const root = mkdtempSync(join(tmpdir(), "background-credentials-"));
	try {
		for (const mode of [0o400, 0o600]) {
			const path = join(root, `${mode}.json`);
			writeFileSync(path, "secret");
			chmodSync(path, mode);
			assert.equal(readSecureCredentialText(path), "secret");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("secure credentials reject symlinks, directories, and permissive modes", () => {
	const root = mkdtempSync(join(tmpdir(), "background-credentials-"));
	try {
		const target = join(root, "target");
		const link = join(root, "link");
		writeFileSync(target, "secret");
		chmodSync(target, 0o600);
		symlinkSync(target, link);
		assert.throws(() => readSecureCredentialText(link), /securely read|credential file/);
		const directory = join(root, "directory");
		mkdirSync(directory);
		assert.throws(() => readSecureCredentialText(directory), /regular file|securely read/);
		const permissive = join(root, "permissive");
		writeFileSync(permissive, "secret");
		chmodSync(permissive, 0o644);
		assert.throws(() => readSecureCredentialText(permissive), /owner-only|securely read/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
