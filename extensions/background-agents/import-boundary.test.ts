import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test } from "node:test";

test("the auto-discovered extension stays on the Node 18-safe client/UI boundary", () => {
	const root = dirname(fileURLToPath(import.meta.url));
	const pending = [resolve(root, "index.ts")];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const path = pending.pop()!;
		if (visited.has(path)) continue;
		visited.add(path);
		const source = readFileSync(path, "utf8");
		assert.doesNotMatch(source, /node:sqlite|[\\/]controller[\\/]|database\.ts/);
		for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
			const importPath = match[1];
			if (importPath) pending.push(resolve(dirname(path), importPath));
		}
	}
	assert.ok(visited.has(resolve(root, "client.ts")));
	assert.ok(visited.has(resolve(root, "ui/dashboard.ts")));
});
