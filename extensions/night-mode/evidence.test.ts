import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	formatEvidenceLine,
	parseEvidence,
	parseEvidenceValue,
	validateClosure,
	verifyEvidence,
} from "./evidence.ts";

describe("parseEvidence", () => {
	it("reads a typed line", () => {
		const evidence = parseEvidence("notes\nEvidence: file /tmp/report.md\n");
		assert.equal(evidence?.kind, "file");
		assert.equal(evidence?.value, "/tmp/report.md");
	});

	it("reads the repository a commit belongs to, inline or as a field", () => {
		assert.equal(parseEvidenceValue("commit abc1234 (repo: /src/phishing)")?.repo, "/src/phishing");
		assert.equal(parseEvidence("Evidence: commit abc1234\nRepo: /src/phishing")?.repo, "/src/phishing");
	});

	// Backward compatibility: the store already holds todos written before the
	// typed format, and losing their evidence would reopen finished work.
	it("infers the kind of a line written before the format existed", () => {
		assert.equal(parseEvidenceValue("https://github.com/o/r/pull/12")?.kind, "pr");
		assert.equal(parseEvidenceValue("https://linear.app/x/issue/HS-804")?.kind, "url");
		assert.equal(parseEvidenceValue("/Users/x/note.md")?.kind, "file");
		assert.equal(parseEvidenceValue("069262f8")?.kind, "commit");
		assert.equal(parseEvidenceValue("zsrllyyl")?.kind, "commit");
		assert.equal(parseEvidenceValue("did the thing")?.kind, "unstructured");
	});

	it("round-trips through the canonical line", () => {
		const evidence = parseEvidenceValue("commit abc1234 (repo: /src/x)");
		assert.ok(evidence);
		assert.equal(formatEvidenceLine(evidence), "Evidence: commit abc1234 (repo: /src/x)");
		assert.deepEqual(parseEvidence(formatEvidenceLine(evidence)), evidence);
	});

	it("ignores an empty line", () => {
		assert.equal(parseEvidence("Evidence:"), undefined);
		assert.equal(parseEvidence("no evidence here"), undefined);
	});
});

describe("validateClosure", () => {
	it("rejects a close with no evidence", () => {
		const check = validateClosure({ status: "done", body: "finished it" });
		assert.equal(check.ok, false);
		assert.match(check.ok === false ? check.error : "", /without evidence/);
	});

	it("rejects a close whose evidence has no checkable kind", () => {
		const check = validateClosure({ status: "closed", body: "Evidence: I did it, trust me" });
		assert.equal(check.ok, false);
		assert.match(check.ok === false ? check.error : "", /no recognisable kind/);
	});

	it("accepts a close with typed evidence", () => {
		const check = validateClosure({ status: "done", body: "Evidence: pr https://github.com/o/r/pull/1" });
		assert.equal(check.ok, true);
		assert.equal(check.ok === true ? check.evidence?.kind : undefined, "pr");
	});

	it("rejects a skip with no reason", () => {
		const check = validateClosure({ status: "skipped", body: "" });
		assert.equal(check.ok, false);
		assert.match(check.ok === false ? check.error : "", /without a reason/);
	});

	it("accepts a skip that carries a reason", () => {
		assert.equal(validateClosure({ status: "blocked", body: "Reason: no egress tonight" }).ok, true);
	});

	it("leaves an open item alone", () => {
		assert.equal(validateClosure({ status: "open", body: "" }).ok, true);
		assert.equal(validateClosure({ status: "in-progress", body: "" }).ok, true);
	});

	it("refuses a placeholder reason for none-with-reason", () => {
		assert.equal(validateClosure({ status: "done", body: "Evidence: none-with-reason n/a" }).ok, false);
	});
});

describe("verifyEvidence: file", () => {
	const dir = mkdtempSync(join(tmpdir(), "night-evidence-"));

	it("passes on a non-empty file", () => {
		const path = join(dir, "report.md");
		writeFileSync(path, "# report\n", "utf-8");
		const result = verifyEvidence({ kind: "file", value: path, raw: path });
		assert.equal(result.ok, true);
	});

	// The exact failure that put a nonexistent path into the 2026-08-31 report.
	it("fails when the file does not exist", () => {
		const path = join(dir, "gone.md");
		const result = verifyEvidence({ kind: "file", value: path, raw: path });
		assert.equal(result.ok, false);
		assert.match(result.detail, /does not exist/);
	});

	it("fails on an empty file and on an empty directory", () => {
		const file = join(dir, "empty.md");
		writeFileSync(file, "", "utf-8");
		assert.equal(verifyEvidence({ kind: "file", value: file, raw: file }).ok, false);
		const emptyDir = join(dir, "artifacts");
		mkdirSync(emptyDir, { recursive: true });
		assert.equal(verifyEvidence({ kind: "file", value: emptyDir, raw: emptyDir }).ok, false);
	});

	it("resolves a relative path against the run's working copy", () => {
		writeFileSync(join(dir, "rel.md"), "x", "utf-8");
		assert.equal(verifyEvidence({ kind: "file", value: "rel.md", raw: "rel.md" }, { cwd: dir }).ok, true);
	});
});

describe("verifyEvidence: commit", () => {
	const seen: Array<{ revision: string; repo: string }> = [];
	const resolveCommit = (revision: string, repo: string) => {
		seen.push({ revision, repo });
		return revision === "good";
	};

	it("passes when the revision resolves in the named repo", () => {
		const result = verifyEvidence({ kind: "commit", value: "good", repo: "/src/x", raw: "" }, { resolveCommit });
		assert.equal(result.ok, true);
		assert.deepEqual(seen.at(-1), { revision: "good", repo: "/src/x" });
	});

	it("fails when it does not", () => {
		const result = verifyEvidence({ kind: "commit", value: "bad", repo: "/src/x", raw: "" }, { resolveCommit });
		assert.equal(result.ok, false);
		assert.match(result.detail, /does not resolve/);
	});

	it("falls back to the run's working copy when no repo is named", () => {
		verifyEvidence({ kind: "commit", value: "good", raw: "" }, { resolveCommit, cwd: "/src/night" });
		assert.equal(seen.at(-1)?.repo, "/src/night");
	});
});

describe("verifyEvidence: urls and prose", () => {
	it("checks the shape of a pull request URL without fetching it", () => {
		const ok = verifyEvidence({ kind: "pr", value: "https://github.com/o/r/pull/12", raw: "" });
		assert.equal(ok.ok, true);
		assert.equal(verifyEvidence({ kind: "pr", value: "github.com/o/r/pull/12", raw: "" }).ok, false);
		assert.equal(verifyEvidence({ kind: "pr", value: "https://github.com/o/r", raw: "" }).ok, false);
	});

	it("accepts any http(s) URL as url evidence", () => {
		assert.equal(verifyEvidence({ kind: "url", value: "https://linear.app/x/HS-1", raw: "" }).ok, true);
		assert.equal(verifyEvidence({ kind: "url", value: "file:///etc/passwd", raw: "" }).ok, false);
	});

	it("accepts a stated absence and passes unstructured evidence through", () => {
		assert.equal(verifyEvidence({ kind: "none-with-reason", value: "no egress tonight", raw: "" }).ok, true);
		assert.equal(verifyEvidence({ kind: "unstructured", value: "done on Friday", raw: "" }).ok, true);
	});
});
