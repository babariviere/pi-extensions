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
	composePlanningPrompt,
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
		assert.equal(applyPathTemplate("{datetime} - Night Report.md", startedAt), "2026-08-29 2130 - Night Report.md");
		assert.equal(applyPathTemplate("<date>/<time>.md", startedAt), "2026-08-29/2130.md");
	});

	it("resolves a relative template against the base directory", () => {
		const config = {
			...DEFAULT_NIGHT_CONFIG,
			reportPathTemplate: "reports/{date}.md",
		};
		assert.equal(reportPathFor(config, startedAt, "/tmp/work"), "/tmp/work/reports/2026-08-29.md");
	});

	it("derives a note name for a wiki-link", () => {
		assert.equal(noteNameFor("/a/b/2026-08-29 2130 - Night Report.md"), "2026-08-29 2130 - Night Report");
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
			plannerModel: "provider/planner",
			orchestratorModel: "provider/orchestrator",
		});
		assert.equal(merged.instructionsPath, "/tmp/i.md");
		assert.equal(merged.maxPullRequests, 2);
		assert.equal(merged.plannerModel, "provider/planner");
		assert.equal(merged.orchestratorModel, "provider/orchestrator");
	});

	it("lets an empty archiveDir disable archiving", () => {
		assert.equal(mergeNightConfig({ archiveDir: "" }).archiveDir, "");
	});

	it("defaults the ledger store to the night directory", () => {
		assert.match(mergeNightConfig({}).todoPath, /night\/todos$/);
	});

	it("takes a custom ledger store, and lets an empty one restore the cwd-derived store", () => {
		assert.equal(mergeNightConfig({ todoPath: " ~/notes/night-todos " }).todoPath, "~/notes/night-todos");
		assert.equal(mergeNightConfig({ todoPath: "" }).todoPath, "");
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
		assert.deepEqual(mergeNightConfig({ sandboxAllowWrite: [] }, base).sandboxAllowWrite, []);
	});

	it("takes custom report sections, ignoring junk entries", () => {
		const merged = mergeNightConfig({ reportSections: ["Tickets", "  ", 3] });
		assert.deepEqual(merged.reportSections, ["Tickets"]);
		assert.deepEqual(mergeNightConfig({ reportSections: [] }).reportSections, DEFAULT_REPORT_SECTIONS);
	});
	it("leaves stale sandbox network keys inert instead of erroring", () => {
		// A handshake / settings file written before the Seatbelt migration may
		// still carry these keys. There is no schema validation on this path
		// (readNightConfig / mergeNightConfig), so an unknown key must simply be
		// ignored rather than throwing or resurrecting network config.
		const merged = mergeNightConfig({
			sandboxAllowedDomains: ["github.com"],
			sandboxAllowLoopback: true,
			sandboxMode: "read-only",
		});
		assert.equal(merged.sandboxMode, "read-only");
		assert.equal((merged as unknown as Record<string, unknown>).sandboxAllowedDomains, undefined);
		assert.equal((merged as unknown as Record<string, unknown>).sandboxAllowLoopback, undefined);
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
		assert.equal(hasInstructions("---\ntags: []\n---\n- fix the flaky test"), true);
	});
});

describe("composePlanningPrompt", () => {
	it("keeps Astra in planning and allows exploratory subagents", () => {
		const text = composePlanningPrompt({
			prompt: "Inspect routine sources",
			instructions: "Check documentation",
			windowLabel: "21:00-09:00",
		});
		assert.match(text, /Build a proposed plan only/);
		assert.match(text, /spawn subagents to explore/);
		assert.match(text, /night_plan/);
		assert.match(text, /Check documentation/);
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

	it("contains only the tasks approved in the previous session", () => {
		const text = composeNightPrompt({
			...base,
			instructions: "",
			approvedTasks: [
				{
					id: "abcd1234",
					title: "Approved docs",
					goal: "Correct docs",
					repository: "/repo",
					definitionOfDone: "Draft PR opened",
				},
			],
		});
		assert.match(text, /Only these tasks are authorized/);
		assert.match(text, /TODO-abcd1234 Approved docs/);
	});
});

describe("orchestrator contract", () => {
	it("names the delegation mechanics the coordinator has to use", () => {
		assert.match(ORCHESTRATOR_CONTRACT, /night: true/);
		assert.match(ORCHESTRATOR_CONTRACT, /nightTodoId/);
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
		const header = composeReportHeader(startedAt, "21:00-09:00", ["Tickets", "CI"]);
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

describe("capability journal", () => {
	const compose = (capabilityPath?: string): string =>
		composeNightPrompt({
			prompt: "",
			instructions: "",
			reportPath: "/notes/2026-09-02 2048 - Night Report.md",
			maxPullRequests: 5,
			windowLabel: "20:00-09:00",
			startedAt,
			...(capabilityPath ? { capabilityPath } : {}),
		});

	it("points the coordinator at the journal and forbids retrying a broken capability", () => {
		const prompt = compose("/sandboxes/repo.agents/capability-journal.jsonl");
		assert.match(prompt, /Capability journal: `\/sandboxes\/repo\.agents\/capability-journal\.jsonl`/);
		assert.match(prompt, /`broken` is not worth another attempt/);
		assert.match(prompt, /append, never rewrite/);
	});

	it("says nothing about a journal when the run has no path for one", () => {
		assert.doesNotMatch(compose(), /Capability journal/);
	});

	it("tells the coordinator a launch failure is a runner fault, not a task fault", () => {
		assert.match(ORCHESTRATOR_CONTRACT, /failure: 'launch'/);
		assert.match(ORCHESTRATOR_CONTRACT, /never rewrite, shorten or re-persona the task/);
	});
});

describe("capability-gated item selection", () => {
	it("tells the coordinator to check an item's needs before claiming it", () => {
		assert.match(ORCHESTRATOR_CONTRACT, /declares it/);
		assert.match(ORCHESTRATOR_CONTRACT, /Reason: needs <capability>/);
		// The 2026-09-02 outcome this exists to prevent.
		assert.match(ORCHESTRATOR_CONTRACT, /draft PR that cannot pass review is worse/);
	});
});

describe("delegation rules earned from past nights", () => {
	it("requires a number in the definition of done", () => {
		// 2026-08-28e #4: a task with no number in its definition of done gets graded
		// as done by the child.
		assert.match(ORCHESTRATOR_CONTRACT, /definition of done carries a number/);
		assert.match(ORCHESTRATOR_CONTRACT, /grades itself against what you wrote/);
	});

	it("sends retrieval-shaped children to the cheaper model", () => {
		// 2026-08-28e #6, re-reported five passes running.
		assert.match(ORCHESTRATOR_CONTRACT, /claude-sonnet-5/);
		assert.match(ORCHESTRATOR_CONTRACT, /Keep the default for children that write code/);
	});
});

describe("buildNightContract", () => {
	const run = {
		startedAt: Date.now(),
		reportPath: "/notes/Reports/report.md",
		maxPullRequests: 5,
		ledgerDir: "/night/todos",
	};

	it("makes the child close its own ledger item", () => {
		// 2026-08-31 #5: four of six carried-over items were finished, because
		// nobody wrote the Evidence line.
		const contract = buildNightContract(run);
		assert.match(contract, /Close your own ledger item before you return/);
		assert.match(contract, /`Evidence:` or `Reason:` line yourself/);
	});

	it("says nothing about the ledger when the run has no store", () => {
		const { ledgerDir: _ledgerDir, ...withoutStore } = run;
		assert.doesNotMatch(buildNightContract(withoutStore), /Close your own ledger item/);
	});

	it("forbids the side notes that used to litter the vault", () => {
		assert.match(buildNightContract(run), /No dated note beside the report/);
	});
});
