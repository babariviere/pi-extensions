import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isSensitiveEnvVarName,
	maskEnvAssignments,
	maskFnoxSecret,
	maskKnownSecrets,
	maskUrls,
	partialMask,
	scrubText,
	shouldMaskEnvVarValue,
} from "./secret-mask.ts";

test("partialMask shows prefix and suffix, hides the middle", () => {
	assert.equal(partialMask("supersecretvalue1234", 4, 2), "supe****34");
});

test("partialMask returns the mask alone when the token is too short", () => {
	assert.equal(partialMask("short", 4, 2), "****");
});

test("partialMask with showEnd=0 never reveals the full token", () => {
	const out = partialMask("supersecretvalue1234", 4, 0);
	assert.equal(out, "supe****");
	assert.ok(!out.includes("supersecretvalue1234"));
});

test("maskKnownSecrets masks GitHub tokens regardless of length drift", () => {
	const token36 = `ghp_${"a".repeat(36)}`;
	const token40 = `ghp_${"a".repeat(40)}`;
	const out36 = maskKnownSecrets(token36);
	const out40 = maskKnownSecrets(token40);
	assert.ok(!out36.includes(token36), "36-char token must be masked");
	assert.ok(!out40.includes(token40), "40-char token must be masked");
	assert.ok(out40.startsWith("ghp_aa"));
});

test("maskKnownSecrets masks fine-grained PATs of varying length", () => {
	const pat = `github_pat_${"A".repeat(90)}`;
	assert.ok(!maskKnownSecrets(pat).includes(pat));
});

test("maskUrls masks userinfo passwords and sensitive query params", () => {
	assert.equal(maskUrls("https://user:hunter2pass@host/x"), "https://user:****@host/x");
	const masked = maskUrls("https://x.com/?api_key=abcdefgh123456");
	assert.ok(!masked.includes("abcdefgh123456"));
});

test("maskUrls leaves non-secret query params alone", () => {
	const url = "https://x.com/?sort_key=created_at_desc";
	assert.equal(maskUrls(url), url);
});

test("isSensitiveEnvVarName flags secrets and excludes false positives", () => {
	assert.equal(isSensitiveEnvVarName("API_KEY"), true);
	assert.equal(isSensitiveEnvVarName("OPENAI_KEY"), true);
	assert.equal(isSensitiveEnvVarName("AWS_SECRET_ACCESS_KEY"), true);
	assert.equal(isSensitiveEnvVarName("SORT_KEY"), false);
	assert.equal(isSensitiveEnvVarName("PRIMARY_KEY"), false);
	assert.equal(isSensitiveEnvVarName("MONKEY"), false);
	assert.equal(isSensitiveEnvVarName("PUBLIC_KEY"), false);
});

test("shouldMaskEnvVarValue requires a sensitive name and a long-enough value", () => {
	assert.equal(shouldMaskEnvVarValue("API_KEY", "tooshort"), true);
	assert.equal(shouldMaskEnvVarValue("API_KEY", "short"), false);
	assert.equal(shouldMaskEnvVarValue("SORT_KEY", "created_at_desc"), false);
});

test("maskEnvAssignments masks sensitive assignments only", () => {
	const masked = maskEnvAssignments("export API_KEY=supersecretvalue");
	assert.ok(!masked.includes("supersecretvalue"));
	assert.ok(masked.startsWith("export API_KEY="));
	const untouched = "SORT_KEY=created_at_desc";
	assert.equal(maskEnvAssignments(untouched), untouched);
});

test("maskFnoxSecret keeps a type-identifying prefix", () => {
	const out = maskFnoxSecret(`ghp_${"a".repeat(36)}`, "GH_TOKEN");
	assert.ok(out.startsWith("[GH_TOKEN: ghp_"));
	assert.ok(out.endsWith("]"));
});

test("scrubText masks exact fnox values and is idempotent", () => {
	const secrets = [{ name: "MY_SECRET", value: "mytopsecretvalue123456" }];
	const once = scrubText("token is mytopsecretvalue123456 here", secrets);
	assert.ok(!once.includes("mytopsecretvalue123456"));
	assert.equal(scrubText(once, secrets), once);
});
