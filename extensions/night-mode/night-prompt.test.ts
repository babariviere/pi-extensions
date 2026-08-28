import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyPathTemplate,
	DEFAULT_NIGHT_CONFIG,
	DEFAULT_REPORT_SECTIONS,
	formatDateTimeStamp,
	mergeNightConfig,
	noteNameFor,
	reportPathFor,
} from "./config.ts";
import { buildNightContract } from "./night-run.ts";
import {
	composeNightPrompt,
	composeNudge,
	composeReportHeader,
	hasInstructions,
	ORCHESTRATOR_CONTRACT,
	timelineLine,
} from "./prompt.ts";

const startedAt = new Date(2026, 7, 29, 21, 30, 0, 0);

describe("path templating", () => {
	it("stamps a date and time for file names", () => {
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

	it("derives a note name for a wiki-link", () => {
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

	it("takes extra writable roots, ignoring junk entries", () => {
		const merged = mergeNightConfig({
			sandboxAllowWrite: [" ~/src/other ", "", 7],
		});
		assert.deepEqual(merged.sandboxAllowWrite, ["~/src/other"]);
		assert.deepEqual(mergeNightConfig({}).sandboxAllowWrite, []);
	});

	it("lets an empty list clear inherited writable roots", () => {
		const base = mergeNightConfig({ sandboxAllowWrite: ["~/src/other"] });
		assert.deepEqual(
			mergeNightConfig({ sandboxAllowWrite: [] }, base).sandboxAllowWrite,
			[],
		);
	});

	it("takes custom report sections, ignoring junk entries", () => {
		const merged = mergeNightConfig({ reportSections: ["Tickets", "  ", 3] });
		assert.deepEqual(merged.reportSections, ["Tickets"]);
		assert.deepEqual(
			mergeNightConfig({ reportSections: [] }).reportSections,
			DEFAULT_REPORT_SECTIONS,
		);
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
			instructions: "- ship the spike",
		});
		assert.match(text, /ship the spike/);
		assert.doesNotMatch(text, /None tonight/);
	});

	it("points the run at its private working copy when there is one", () => {
		const text = composeNightPrompt({
			...base,
			instructions: "",
			workspacePath: "/sandboxes/repo/2026-08-29 2130",
		});
		assert.match(text, /Working copy: `\/sandboxes\/repo\/2026-08-29 2130`/);
		assert.match(text, /own checkout is off limits/);
	});

	it("says nothing about a working copy when cloning is off", () => {
		const text = composeNightPrompt({ ...base, instructions: "" });
		assert.doesNotMatch(text, /Working copy:/);
	});
});

describe("orchestrator contract", () => {
	it("names the delegation mechanics the coordinator has to use", () => {
		assert.match(ORCHESTRATOR_CONTRACT, /night: true/);
		assert.match(ORCHESTRATOR_CONTRACT, /reads/);
		assert.match(ORCHESTRATOR_CONTRACT, /output/);
		assert.match(ORCHESTRATOR_CONTRACT, /Evidence:/);
	});

	it("is carried by the start prompt, so a base prompt cannot omit it", () => {
		const text = composeNightPrompt({
			prompt: "# Night Run\nDo the work.",
			instructions: "",
			reportPath: "/tmp/report.md",
			maxPullRequests: 5,
			windowLabel: "21:00-09:00",
			startedAt,
		});
		assert.ok(text.includes(ORCHESTRATOR_CONTRACT));
	});

	it("re-states delegation in a continuation, when the agent is drifting", () => {
		const nudge = composeNudge({
			unresolved: "- HS-1234 allowlist",
			reportPath: "/tmp/report.md",
			attempt: 1,
			maxAttempts: 3,
		});
		assert.match(nudge, /orchestrator/);
		assert.match(nudge, /night: true/);
	});
});

describe("report skeleton", () => {
	it("has every section the prompt promises", () => {
		const header = composeReportHeader(startedAt, "21:00-09:00");
		for (const section of DEFAULT_REPORT_SECTIONS) {
			assert.ok(header.includes(`## ${section}`), `missing ## ${section}`);
		}
		assert.match(header, /# Night Report - 2026-08-29 2130/);
	});

	it("uses the configured sections instead", () => {
		const header = composeReportHeader(startedAt, "21:00-09:00", [
			"Tickets",
			"CI",
		]);
		assert.match(header, /## Tickets/);
		assert.match(header, /## CI/);
		assert.doesNotMatch(header, /## Summary/);
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
		assert.match(contract, /never send a message/);
		assert.match(contract, /draft/);
		assert.match(contract, /capped at 3 pull requests/);
		assert.match(contract, /\/tmp\/report\.md/);
	});

	it("sends subagents into the run's working copy when one exists", () => {
		const contract = buildNightContract({
			startedAt: 0,
			reportPath: "/tmp/report.md",
			maxPullRequests: 3,
			workspacePath: "/sandboxes/repo/2026-08-29 2130",
		});
		assert.match(contract, /Work in `\/sandboxes\/repo\/2026-08-29 2130`/);
		assert.match(contract, /never touch the user's own checkout/);
	});

	it("tells a subagent with its own workspace to stay in it", () => {
		const contract = buildNightContract(
			{
				startedAt: 0,
				reportPath: "/tmp/report.md",
				maxPullRequests: 3,
				workspacePath: "/sandboxes/repo/2026-08-29 2130",
			},
			"/sandboxes/repo/2026-08-29 2130.agents/agent-abc-0",
		);
		assert.match(contract, /Work in `[^`]*\.agents\/agent-abc-0`/);
		assert.match(contract, /already your working directory/);
		assert.doesNotMatch(contract, /`cd` there first/);
	});

	it("omits the working-copy rule when the run has none", () => {
		const contract = buildNightContract({
			startedAt: 0,
			reportPath: "/tmp/report.md",
			maxPullRequests: 3,
		});
		assert.doesNotMatch(contract, /Work in `/);
	});
});
