import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AgentConfig } from "./frontmatter.ts";
import { type DiscoveredAgent } from "./discovery.ts";
import { buildRunRequests, normalizeRequests, validateOverrides } from "./request.ts";

function agent(name: string, config: Partial<AgentConfig> = {}): DiscoveredAgent {
	return { config: { name, ...config }, systemPrompt: "", sourcePath: `/tmp/${name}.md`, scope: "user" };
}

/** A cwd with no settings files, so no enabledModels restriction applies. */
function bareCwd(): string {
	return mkdtempSync(join(tmpdir(), "req-test-"));
}

/** A cwd whose project settings restrict enabledModels. */
function cwdWithEnabled(models: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "req-test-"));
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ enabledModels: models }));
	return dir;
}

test("normalizeRequests rejects providing both single and parallel shapes", () => {
	const r = normalizeRequests({ agent: "a", task: "t", tasks: [{ agent: "b", task: "u" }] });
	assert.ok("error" in r && /not both/.test(r.error));
});

test("normalizeRequests requires both agent and task for a single run", () => {
	assert.ok("error" in normalizeRequests({ agent: "a" }));
	assert.ok("error" in normalizeRequests({ task: "t" }));
});

test("normalizeRequests errors when nothing is provided", () => {
	assert.ok("error" in normalizeRequests({}));
});

test("buildRunRequests binds a single item to its agent and indexes it", () => {
	const agents = [agent("worker")];
	const r = buildRunRequests({ agent: "worker", task: "do it" }, agents, bareCwd());
	assert.ok("requests" in r);
	assert.equal(r.requests.length, 1);
	assert.equal(r.requests[0].agent.config.name, "worker");
	assert.equal(r.requests[0].index, 0);
	assert.equal(r.requests[0].task, "do it");
});

test("buildRunRequests reports an unknown agent with the available names", () => {
	const r = buildRunRequests({ agent: "ghost", task: "t" }, [agent("worker")], bareCwd());
	assert.ok("error" in r && /Unknown agent 'ghost'/.test(r.error) && /worker/.test(r.error));
});

test("buildRunRequests falls back to agent config output and defaultReads", () => {
	const agents = [agent("planner", { output: ".pi/plan.md", defaultReads: ["a.md", "b.md"] })];
	const r = buildRunRequests({ agent: "planner", task: "plan" }, agents, bareCwd());
	assert.ok("requests" in r);
	assert.equal(r.requests[0].output, ".pi/plan.md");
	assert.deepEqual(r.requests[0].reads, ["a.md", "b.md"]);
});

test("buildRunRequests lets per-run output and reads override agent config", () => {
	const agents = [agent("planner", { output: ".pi/plan.md", defaultReads: ["a.md"] })];
	const r = buildRunRequests({ agent: "planner", task: "plan", output: "out.md", reads: ["z.md"] }, agents, bareCwd());
	assert.ok("requests" in r);
	assert.equal(r.requests[0].output, "out.md");
	assert.deepEqual(r.requests[0].reads, ["z.md"]);
});

test("buildRunRequests keeps a single run's output override verbatim", () => {
	const r = buildRunRequests({ agent: "planner", task: "plan", output: ".pi/goal/plan.md" }, [agent("planner")], bareCwd());
	assert.ok("requests" in r);
	assert.equal(r.requests[0].output, ".pi/goal/plan.md"); // no -index suffix for a single run
});

test("buildRunRequests suffixes shared output overrides per index for parallel runs", () => {
	// The failure this guards: several tasks sharing one output value used to
	// resolve to the same file and clobber each other (only the last write
	// survived, so all runs read back identical content).
	const agents = [agent("reviewer")];
	const r = buildRunRequests({
		tasks: [
			{ agent: "reviewer", task: "a", output: "review.md" },
			{ agent: "reviewer", task: "b", output: "review.md" },
			{ agent: "reviewer", task: "c", output: "review.md" },
		],
	}, agents, bareCwd());
	assert.ok("requests" in r);
	assert.deepEqual(r.requests.map((x) => x.output), ["review-0.md", "review-1.md", "review-2.md"]);
});

test("buildRunRequests suffixes an agent-config output default across parallel runs", () => {
	const agents = [agent("reviewer", { output: "out/report.md" })];
	const r = buildRunRequests({
		tasks: [
			{ agent: "reviewer", task: "a" },
			{ agent: "reviewer", task: "b" },
		],
	}, agents, bareCwd());
	assert.ok("requests" in r);
	assert.deepEqual(r.requests.map((x) => x.output), [join("out", "report-0.md"), join("out", "report-1.md")]);
});

test("buildRunRequests leaves runs without an output override on their unique default path", () => {
	const agents = [agent("a"), agent("b")];
	const r = buildRunRequests({
		tasks: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }],
	}, agents, bareCwd());
	assert.ok("requests" in r);
	// No override set, so nothing to disambiguate; the backend uses the per-index default path.
	assert.deepEqual(r.requests.map((x) => x.output), [undefined, undefined]);
});

test("validateOverrides rejects an unknown thinking level", () => {
	const err = validateOverrides([{ agent: "a", task: "t", thinking: "ultra" }], bareCwd());
	assert.ok(err && /Invalid thinking level 'ultra'/.test(err));
});

test("validateOverrides rejects a model outside enabledModels", () => {
	const cwd = cwdWithEnabled(["anthropic/claude-sonnet-5"]);
	const err = validateOverrides([{ agent: "a", task: "t", model: "some/expensive-model" }], cwd);
	assert.ok(err && /not in enabledModels/.test(err));
});

test("validateOverrides accepts an allowlisted model ignoring the thinking suffix", () => {
	const cwd = cwdWithEnabled(["anthropic/claude-sonnet-5"]);
	assert.equal(validateOverrides([{ agent: "a", task: "t", model: "anthropic/claude-sonnet-5:high" }], cwd), undefined);
});

test("validateOverrides imposes no model restriction when the allowlist is empty", () => {
	// An explicit empty enabledModels means "no restriction"; use a project
	// settings file so the check is independent of the machine's user settings.
	assert.equal(validateOverrides([{ agent: "a", task: "t", model: "anything/goes" }], cwdWithEnabled([])), undefined);
});
