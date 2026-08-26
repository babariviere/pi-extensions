import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyPathTemplate,
	DEFAULT_NIGHT_CONFIG,
	formatDateTimeStamp,
	mergeNightConfig,
	noteNameFor,
	reportPathFor,
} from "./config.ts";
import { buildNightContract } from "./night-run.ts";
import {
	composeNightPrompt,
	composeReportHeader,
	hasInstructions,
	timelineLine,
} from "./prompt.ts";

const startedAt = new Date(2026, 7, 29, 21, 30, 0, 0);

describe("path templating", () => {
	it("stamps dates the way the vault names notes", () => {
		assert.equal(formatDateTimeStamp(startedAt), "2026-08-29 2130");
	});

	it("expands both the {datetime} and <datetime> spellings", () => {
		assert.equal(
			applyPathTemplate("{datetime} - Night Report.md", startedAt),
			"2026-08-29 2130 - Night Report.md",
		);
		assert.equal(
			applyPathTemplate("<date>/<time>.md", startedAt),
			"2026-08-29/2130.md",
		);
	});

	it("resolves a relative template against the base directory", () => {
		const config = {
			...DEFAULT_NIGHT_CONFIG,
			reportPathTemplate: "reports/{date}.md",
		};
		assert.equal(
			reportPathFor(config, startedAt, "/tmp/work"),
			"/tmp/work/reports/2026-08-29.md",
		);
	});

	it("derives an Obsidian note name", () => {
		assert.equal(
			noteNameFor("/a/b/2026-08-29 2130 - Night Report.md"),
			"2026-08-29 2130 - Night Report",
		);
	});
});

describe("mergeNightConfig", () => {
	it("keeps defaults for missing or junk fields", () => {
		const merged = mergeNightConfig({ promptPath: "  ", maxPullRequests: -3 });
		assert.equal(merged.promptPath, DEFAULT_NIGHT_CONFIG.promptPath);
		assert.equal(merged.maxPullRequests, DEFAULT_NIGHT_CONFIG.maxPullRequests);
	});

	it("overrides what it is given", () => {
		const merged = mergeNightConfig({
			instructionsPath: "/tmp/i.md",
			maxPullRequests: 2,
		});
		assert.equal(merged.instructionsPath, "/tmp/i.md");
		assert.equal(merged.maxPullRequests, 2);
	});

	it("lets an empty archiveDir disable archiving", () => {
		assert.equal(mergeNightConfig({ archiveDir: "" }).archiveDir, "");
	});
});

describe("hasInstructions", () => {
	it("ignores whitespace and a bare frontmatter block", () => {
		assert.equal(hasInstructions(""), false);
		assert.equal(hasInstructions("\n\n \n"), false);
		assert.equal(hasInstructions("---\ntags:\n  - night\n---\n"), false);
	});

	it("sees real content", () => {
		assert.equal(hasInstructions("- fix the flaky test"), true);
		assert.equal(
			hasInstructions("---\ntags: []\n---\n- fix the flaky test"),
			true,
		);
	});
});

describe("composeNightPrompt", () => {
	const base = {
		prompt: "# Night Run\nDo the work.",
		reportPath: "/tmp/report.md",
		maxPullRequests: 5,
		windowLabel: "21:00-09:00",
		startedAt,
	};

	it("carries the report path, the cap and the base prompt", () => {
		const text = composeNightPrompt({ ...base, instructions: "" });
		assert.match(text, /\/tmp\/report\.md/);
		assert.match(text, /cap for tonight: 5/);
		assert.match(text, /Do the work\./);
	});

	it("says so explicitly when there is nothing extra", () => {
		const text = composeNightPrompt({ ...base, instructions: "\n\n" });
		assert.match(text, /None tonight/);
	});

	it("inlines the extra instructions above the default routine", () => {
		const text = composeNightPrompt({
			...base,
			instructions: "- ship the vishing spike",
		});
		assert.match(text, /ship the vishing spike/);
		assert.doesNotMatch(text, /None tonight/);
	});
});

describe("report skeleton", () => {
	it("has every section the prompt promises", () => {
		const header = composeReportHeader(startedAt, "21:00-09:00");
		for (const section of [
			"Summary",
			"Needs Bastien",
			"Linear",
			"CI",
			"Slack",
			"Daily note",
			"Skipped / failed",
			"Timeline",
		]) {
			assert.ok(header.includes(`## ${section}`), `missing ## ${section}`);
		}
		assert.match(header, /# Night Report - 2026-08-29 2130/);
	});

	it("stamps timeline lines with a local clock", () => {
		assert.equal(timelineLine(startedAt, "paused"), "- 21:30 paused\n");
	});
});

describe("buildNightContract", () => {
	it("states the hard rules and the report path", () => {
		const contract = buildNightContract({
			startedAt: 0,
			reportPath: "/tmp/report.md",
			maxPullRequests: 3,
		});
		assert.match(contract, /Slack is read-only/);
		assert.match(contract, /draft/);
		assert.match(contract, /capped at 3 pull requests/);
		assert.match(contract, /\/tmp\/report\.md/);
	});
});
