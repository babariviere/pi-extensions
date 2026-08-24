import assert from "node:assert/strict";
import { test } from "node:test";
import { scrubDeep, scrubText, SECRET_PATTERNS } from "./secret-mask.ts";
import { hasMaskArtifact, SecretRefRegistry } from "./secret-ref.ts";

const KEY = "a".repeat(64);
const GH = `ghp_${"a".repeat(36)}`;
const GH2 = `ghp_${"b".repeat(36)}`;

test("ref format is <secret:label:id> with a hex id", () => {
	const reg = new SecretRefRegistry(KEY);
	const entry = reg.registerNamed("GITHUB_TOKEN", GH);
	assert.match(entry.ref, /^<secret:github-token:[0-9a-f]{8}>$/);
});

test("ids are content-addressed: same value, same ref", () => {
	const reg = new SecretRefRegistry(KEY);
	assert.equal(reg.register(GH, { label: "github-token" }).ref, reg.register(GH, { label: "other" }).ref);
});

test("distinct values of the same kind get distinct refs", () => {
	const reg = new SecretRefRegistry(KEY);
	const a = reg.register(GH, { label: "github-token" });
	const b = reg.register(GH2, { label: "github-token" });
	assert.notEqual(a.ref, b.ref);
	assert.equal(a.label, b.label);
});

test("ids differ across sessions", () => {
	const a = new SecretRefRegistry(KEY).register(GH, { label: "t" });
	const b = new SecretRefRegistry("b".repeat(64)).register(GH, { label: "t" });
	assert.notEqual(a.id, b.id);
});

test("scrub then hydrate round-trips a file byte for byte", () => {
	const reg = new SecretRefRegistry(KEY);
	const secrets = [{ name: "GITHUB_TOKEN", value: GH }];
	const original = `GITHUB_TOKEN=${GH}\nOTHER=plain\n`;
	const scrubbed = scrubText(original, secrets, reg);
	assert.ok(!scrubbed.includes(GH));
	assert.equal(reg.hydrate(scrubbed, "value").text, original);
});

test("round-trips a pattern-detected secret that fnox never saw", () => {
	const reg = new SecretRefRegistry(KEY);
	const original = `token: ${GH}\nsecond: ${GH2}\n`;
	const scrubbed = scrubText(original, [], reg);
	assert.ok(!scrubbed.includes(GH));
	assert.ok(!scrubbed.includes(GH2));
	assert.equal(reg.hydrate(scrubbed, "value").text, original);
});

test("scrubbing is idempotent: refs survive a second pass", () => {
	const reg = new SecretRefRegistry(KEY);
	const once = scrubText(`token: ${GH}`, [], reg);
	assert.equal(scrubText(once, [], reg), once);
});

test("a sensitive assignment whose value only contains a secret still round-trips", () => {
	// Regression: the env layer used to wrap the ref minted by the pattern layer,
	// so hydration returned the inner ref and the secret was lost silently.
	const reg = new SecretRefRegistry(KEY);
	const original = `AUTH_TOKEN=Bearer ${GH}\n`;
	const scrubbed = scrubText(original, [], reg);
	assert.ok(!scrubbed.includes(GH));
	const back = reg.hydrate(scrubbed, "value");
	assert.equal(back.text, original);
	assert.deepEqual(back.unresolved, []);
});

test("a URL password inside a sensitive assignment round-trips", () => {
	const reg = new SecretRefRegistry(KEY);
	const original = "SECRET_URL=postgres://admin:hunter2hunter2@db/prod\n";
	const scrubbed = scrubText(original, [], reg);
	assert.ok(!scrubbed.includes("hunter2hunter2"));
	assert.equal(reg.hydrate(scrubbed, "value").text, original);
});

test("authoring ref resolves an env-backed secret by name", () => {
	const reg = new SecretRefRegistry(KEY);
	reg.registerNamed("GITHUB_TOKEN", GH);
	const out = reg.hydrate("token=<secret:GITHUB_TOKEN>", "value");
	assert.equal(out.text, `token=${GH}`);
	assert.deepEqual(out.unresolved, []);
});

test("authoring ref resolves a fnox name that is not upper snake case", () => {
	const reg = new SecretRefRegistry(KEY);
	reg.registerNamed("github_token", GH);
	const out = reg.hydrate("token=<secret:github_token>", "value");
	assert.equal(out.text, `token=${GH}`);
	assert.deepEqual(out.unresolved, []);
});

test("one value backed by two names resolves under either", () => {
	const reg = new SecretRefRegistry(KEY);
	reg.registerNamed("GITHUB_TOKEN", GH);
	reg.registerNamed("GH_TOKEN", GH);
	assert.equal(reg.hydrate("<secret:GH_TOKEN>", "value").text, GH);
});

test("unknown ids are reported, never silently written", () => {
	const reg = new SecretRefRegistry(KEY);
	const out = reg.hydrate("x=<secret:github-token:deadbeef>", "value");
	assert.equal(out.text, "x=<secret:github-token:deadbeef>");
	assert.deepEqual(out.unresolved, ["<secret:github-token:deadbeef>"]);
});

test("env mode rewrites to a brace expansion, never the value", () => {
	const reg = new SecretRefRegistry(KEY);
	const { ref } = reg.registerNamed("GITHUB_TOKEN", GH);
	const out = reg.hydrate(`curl -H "Authorization: Bearer ${ref}"`, "env");
	assert.equal(out.text, 'curl -H "Authorization: Bearer ${GITHUB_TOKEN}"');
	assert.ok(!out.text.includes(GH));
});

test("env mode refuses a ref inside single quotes, where it would not expand", () => {
	const reg = new SecretRefRegistry(KEY);
	const { ref } = reg.registerNamed("GITHUB_TOKEN", GH);
	const out = reg.hydrate(`echo '${ref}'`, "env");
	assert.deepEqual(out.unresolved, [ref]);
	assert.ok(!out.text.includes(GH));
});

test("env mode refuses a detected secret with no env var behind it", () => {
	const reg = new SecretRefRegistry(KEY);
	const { ref } = reg.register(GH, { label: "github-token" });
	const out = reg.hydrate(`echo ${ref}`, "env");
	assert.deepEqual(out.unresolved, [ref]);
	assert.ok(!out.text.includes(GH));
});

test("escaped refs pass through as literal text", () => {
	const reg = new SecretRefRegistry(KEY);
	reg.registerNamed("GITHUB_TOKEN", GH);
	const out = reg.hydrate("template: <\\secret:GITHUB_TOKEN>", "value");
	assert.equal(out.text, "template: <secret:GITHUB_TOKEN>");
	assert.deepEqual(out.unresolved, []);
});

test("a ref already present in a file is escaped, so writing it back plants nothing", () => {
	// Otherwise a template line written for some other tool turns into a real
	// credential the first time the model rewrites that file.
	const reg = new SecretRefRegistry(KEY);
	reg.registerNamed("GITHUB_TOKEN", GH);
	const onDisk = "token = <secret:GITHUB_TOKEN>\n";
	const modelSees = scrubText(onDisk, [{ name: "GITHUB_TOKEN", value: GH }], reg);
	assert.equal(modelSees, "token = <\\secret:GITHUB_TOKEN>\n");
	const back = reg.hydrate(modelSees, "value");
	assert.equal(back.text, onDisk);
	assert.ok(!back.text.includes(GH));
});

test("scan ignores escaped refs", () => {
	const reg = new SecretRefRegistry(KEY);
	assert.deepEqual(reg.scan("<\\secret:A_B> <secret:A_B>"), ["<secret:A_B>"]);
});

test("registering a detected value by name upgrades it in place", () => {
	const reg = new SecretRefRegistry(KEY);
	const detected = reg.register(GH, { label: "github-token" });
	const named = reg.registerNamed("GITHUB_TOKEN", GH);
	assert.equal(named.ref, detected.ref);
	assert.equal(named.source, "env");
	assert.equal(reg.hydrate(detected.ref, "env").text, "${GITHUB_TOKEN}");
});

test("hasMaskArtifact catches transcribed masks without flagging prose", () => {
	assert.ok(hasMaskArtifact("TOKEN=ghp_ab****ef"));
	assert.ok(hasMaskArtifact("[GITHUB_TOKEN: ghp_ab****ef]"));
	assert.ok(!hasMaskArtifact("TOKEN=<secret:github-token:9f2c4ab1>"));
	assert.ok(!hasMaskArtifact("**bold** and *emphasis*"));
	// Prose about masking has to stay writable, including this extension's own
	// sources; the marker of another extension is never something this one emits.
	assert.ok(!hasMaskArtifact("the value is shown as prefix****suffix"));
	assert.ok(!hasMaskArtifact("KEY=[REDACTED:TOKEN]"));
});

test("hasMaskArtifact stays cheap on a long unbroken token run", () => {
	const started = Date.now();
	hasMaskArtifact(`${"x".repeat(80000)}****`);
	assert.ok(Date.now() - started < 250, "artifact scan must not backtrack");
});

test("scrubDeep returns the input by reference when nothing changed", () => {
	// index.ts uses this identity to avoid patching an untouched tool result.
	const details = { stdout: "nothing sensitive", exitCode: 0, nested: { a: [1, 2] } };
	assert.equal(scrubDeep(details, [], new SecretRefRegistry(KEY)), details);
});

test("scrubDeep scrubs every reference to a shared subobject", () => {
	// A visited-set cycle guard used to return the unscrubbed original for the
	// second reference, leaking the value into the session file.
	const reg = new SecretRefRegistry(KEY);
	const shared = { token: GH };
	const scrubbed = scrubDeep({ first: shared, second: shared, list: [shared] }, [], reg);
	assert.ok(!JSON.stringify(scrubbed).includes(GH));
});

test("scrubDeep survives a cycle", () => {
	const cyclic: Record<string, unknown> = { note: "plain" };
	cyclic.self = cyclic;
	assert.doesNotThrow(() => scrubDeep(cyclic, [], new SecretRefRegistry(KEY)));
});

/**
 * One sample per detection pattern. Keyed by label so a new pattern without a
 * sample fails the completeness check below rather than going untested.
 */
const PATTERN_SAMPLES: Record<string, string> = {
	"pem-full-block": `-----BEGIN PRIVATE KEY-----\n${"k".repeat(64)}\n${"m".repeat(64)}\n-----END PRIVATE KEY-----`,
	"anthropic-admin": `sk-ant-admin01-${"a".repeat(93)}AA`,
	"anthropic-api": `sk-ant-api03-${"a".repeat(93)}AA`,
	"openai-modern": `sk-proj-${"a".repeat(60)}T3BlbkFJ${"b".repeat(60)}`,
	"openai-legacy": `sk-${"a".repeat(20)}T3BlbkFJ${"b".repeat(20)}`,
	"github-pat-fine": `github_pat_${"A".repeat(70)}`,
	"github-tokens": `ghp_${"c".repeat(36)}`,
	"slack-webhook": `https://hooks.slack.com/services/${"a".repeat(45)}`,
	"slack-config": `xoxe.xoxb-1-${"a".repeat(150)}`,
	"slack-refresh": `xoxe-1-${"a".repeat(150)}`,
	"slack-user": `xoxp-1234567890-1234567890-1234567890-${"a".repeat(30)}`,
	"slack-bot": `xoxb-1234567890-1234567890-${"a".repeat(28)}`,
	"slack-app-level": "xapp-1-ABC123-1234567890-abcdef123",
	sendgrid: `SG.${"a".repeat(22)}.${"b".repeat(43)}`,
	"gitlab-oauth-secret": `gloas-${"a".repeat(64)}`,
	"gitlab-trigger": `glptt-${"a".repeat(40)}`,
	"gitlab-pat": `glpat-${"a".repeat(20)}`,
	"gitlab-runner": `glrt-${"a".repeat(20)}`,
	"google-oauth-access": `ya29.${"a".repeat(30)}`,
	"google-oauth-refresh": `1//${"a".repeat(45)}`,
	"google-oauth-secret": `GOCSPX-${"a".repeat(28)}`,
	"google-api-key": `AIza${"a".repeat(35)}`,
	"stripe-org-secret": `sk_org_${"a".repeat(24)}`,
	"stripe-webhook-secret": `whsec_${"a".repeat(32)}`,
	"stripe-secret": `sk_live_${"a".repeat(24)}`,
	"stripe-publishable": `pk_live_${"a".repeat(24)}`,
	jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
	"npm-token": `npm_${"a".repeat(36)}`,
	huggingface: `hf_${"a".repeat(34)}`,
	"aws-access-key-id": "AKIAABCDEFGHIJKLMNOP",
	"twilio-account-sid": `AC${"0".repeat(32)}`,
	"twilio-api-key": `SK${"0".repeat(32)}`,
	"aws-secret-key": `aws_secret_access_key = ${"a".repeat(40)}`,
	"auth-header-bearer": `Authorization: Bearer ${"a".repeat(30)}`,
};

test("every detection pattern has a round-trip sample", () => {
	const missing = SECRET_PATTERNS.map((p) => p.label).filter((label) => !(label in PATTERN_SAMPLES));
	assert.deepEqual(missing, []);
});

for (const [label, sample] of Object.entries(PATTERN_SAMPLES)) {
	test(`${label} is detected, round-trips, and is idempotent`, () => {
		const reg = new SecretRefRegistry(KEY);
		const original = `line before\n${sample}\nline after\n`;
		const scrubbed = scrubText(original, [], reg);
		assert.notEqual(scrubbed, original, "sample must be detected");
		assert.ok(!scrubbed.includes(sample), "raw value must not survive");
		assert.equal(scrubText(scrubbed, [], reg), scrubbed, "second scrub must be a no-op");
		const back = reg.hydrate(scrubbed, "value");
		assert.deepEqual(back.unresolved, []);
		assert.equal(back.text, original);
	});
}
