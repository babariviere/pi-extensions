import type { DashboardSnapshot } from "../types.ts";

export const DASHBOARD_VIEWS = [
	"case",
	"specification",
	"question",
	"stack",
	"attempt",
	"memory",
	"classifier",
	"feedback",
	"usage",
	"system",
	"rollout",
	"evidence",
] as const;

export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export const DASHBOARD_VIEW_LABELS: Record<DashboardView, string> = {
	case: "Cases",
	specification: "Specification",
	question: "Question brief",
	stack: "PR stack",
	attempt: "Attempts",
	memory: "Memory",
	classifier: "Classifier",
	feedback: "Feedback",
	usage: "Usage",
	system: "System",
	rollout: "Rollout",
	evidence: "Evidence",
};

export function nextDashboardView(view: DashboardView, amount = 1): DashboardView {
	const index = DASHBOARD_VIEWS.indexOf(view);
	return DASHBOARD_VIEWS[(index + amount + DASHBOARD_VIEWS.length) % DASHBOARD_VIEWS.length] ?? "case";
}

function value(value: unknown): string {
	return value === undefined || value === "" ? "-" : String(value);
}

function selectedCase(snapshot: DashboardSnapshot, selectedCaseIndex: number) {
	return snapshot.cases[selectedCaseIndex] ?? snapshot.cases[0];
}

function selectedAttempt(snapshot: DashboardSnapshot, selectedAttemptIndex: number) {
	return snapshot.attempts[selectedAttemptIndex] ?? snapshot.attempts[0];
}

/** Build safe, non-secret dashboard text. Only controller-provided summaries are rendered. */
export function buildDashboardViewLines(
	snapshot: DashboardSnapshot,
	view: DashboardView,
	selectedCaseIndex = 0,
	selectedAttemptIndex = 0,
): string[] {
	const currentCase = selectedCase(snapshot, selectedCaseIndex);
	const currentAttempt = selectedAttempt(snapshot, selectedAttemptIndex);
	const lines = [`${DASHBOARD_VIEW_LABELS[view]}  [${view}]`];

	switch (view) {
		case "case":
			lines.push(`Cases: ${snapshot.cases.length}`);
			if (!currentCase) lines.push("No cases. Use /background bug or /background feature.");
			for (const [index, item] of snapshot.cases.entries())
				lines.push(`${index === selectedCaseIndex ? ">" : " "} ${item.id}  ${item.state}  ${item.title}`);
			if (currentCase) {
				lines.push(`Selected: ${currentCase.id} ${currentCase.title}`);
				lines.push(`Source: ${currentCase.source}  Repository: ${value(currentCase.repository)}`);
				lines.push(`Rollout: ${currentCase.rollout}  Priority: ${value(currentCase.priority)}`);
			}
			break;
		case "specification":
			lines.push(`Case: ${value(currentCase?.id)}  State: ${value(currentCase?.state)}`);
			for (const spec of snapshot.specifications.filter((item) => item.caseId === currentCase?.id))
				lines.push(`v${spec.version} ${spec.id}  ${spec.summary}  unresolved=${spec.unresolvedQuestions.length}`);
			for (const approval of snapshot.approvals.filter((item) => item.caseId === currentCase?.id))
				lines.push(`Approval v${approval.specVersion}: ${approval.decision} by ${approval.actor}`);
			lines.push("Actions: a approve, f feedback, r resume");
			break;
		case "question":
			lines.push(`Case: ${value(currentCase?.id)}`);
			for (const brief of snapshot.questionBriefs.filter((item) => item.caseId === currentCase?.id))
				lines.push(
					`${brief.id}  ${brief.question}  confidence=${brief.confidence}  findings=${brief.findings.length} sources=${brief.sources.length} limits=${brief.limits}`,
				);
			lines.push("Read-only brief; findings and uncertainty are controller-provided.");
			break;
		case "stack":
			lines.push(`Case: ${value(currentCase?.id)}`);
			for (const item of snapshot.workItems.filter((workItem) => workItem.caseId === currentCase?.id))
				lines.push(
					`#${item.ordinal} ${item.title}  ${item.state}  ${value(item.branch)}${item.pullRequest ? ` PR#${item.pullRequest}` : ""}`,
				);
			lines.push(
				`Stack items: ${snapshot.stacks.find((stack) => stack.caseId === currentCase?.id)?.workItemIds.length ?? 0}`,
			);
			break;
		case "attempt":
			lines.push(`Attempts: ${snapshot.attempts.length}`);
			for (const [index, attempt] of snapshot.attempts.entries())
				lines.push(
					`${index === selectedAttemptIndex ? ">" : " "} ${attempt.id}  ${attempt.role}  ${attempt.state}`,
				);
			if (currentAttempt) {
				lines.push(`Selected: ${currentAttempt.id}  Generation: ${currentAttempt.generation}`);
				lines.push(`Model: ${value(currentAttempt.model)}  Profile: ${value(currentAttempt.profileId)}`);
				lines.push(`Systemd: ${value(currentAttempt.systemdUnit)}  Pane: ${value(currentAttempt.paneId)}`);
				lines.push(
					`Artifact references: worktree=${value(currentAttempt.worktree)} branch=${value(currentAttempt.branch)}`,
				);
				for (const job of snapshot.jobs.filter((item) => item.caseId === currentAttempt.caseId))
					lines.push(`Job ${job.id}: ${job.role} ${job.state} priority=${job.priority}`);
				for (const artifact of snapshot.artifacts.filter((item) => item.attemptId === currentAttempt.id))
					lines.push(`Artifact ${artifact.id}: ${artifact.kind} ${value(artifact.url ?? artifact.hash)}`);
				lines.push(`Confidence and uncertainty: recorded with the attempt evidence, not inferred here.`);
			}
			break;
		case "memory":
			lines.push(`Case: ${value(currentCase?.id)}`);
			for (const entry of snapshot.memory.filter((item) => !item.caseId || item.caseId === currentCase?.id))
				lines.push(
					`${entry.id}  ${entry.finding}  ${entry.approvalStatus}  provenance=${entry.provenance} superseded=${entry.supersededByIds.length}`,
				);
			break;
		case "classifier":
			lines.push(`Case: ${value(currentCase?.id)}`);
			for (const classification of snapshot.classifications.filter((item) => item.caseId === currentCase?.id))
				lines.push(
					`${classification.inputKind} ${classification.disposition} action=${classification.actionability} noise=${classification.noise} confidence=${classification.confidence} policy=${classification.policyVersion} model=${classification.modelVersion}`,
				);
			for (const policy of snapshot.policies)
				lines.push(`Policy ${policy.scope}/${policy.version}: ${policy.status}`);
			break;
		case "feedback":
			lines.push(`Case: ${value(currentCase?.id)}`);
			for (const item of snapshot.feedback.filter((feedback) => feedback.caseId === currentCase?.id))
				lines.push(`${item.id} by ${item.actor}: ${item.correction}`);
			lines.push("Actions: c reclassify, f provide specification feedback");
			break;
		case "usage":
			lines.push(`Case: ${value(currentCase?.id)}`);
			lines.push(`Profiles: ${snapshot.profiles.length}`);
			for (const profile of snapshot.profiles)
				lines.push(
					`${profile.id}  ${profile.provider}  attempts ${profile.maxBackgroundAttempts}  reserve ${profile.interactiveReserve}`,
				);
			for (const usage of snapshot.usage)
				lines.push(
					`${usage.profileId} available=${usage.available} active=${usage.activeAttempts}/${usage.concurrencyLimit} ${usage.windows.map((window) => `${window.quotaWindow}:${window.used}/${value(window.remaining)}`).join(" ")}`,
				);
			break;
		case "system":
			lines.push(`Case: ${value(currentCase?.id)}`);
			lines.push(`Controller: ${snapshot.system.controller} started=${snapshot.system.started}`);
			lines.push(`Emergency stop: ${snapshot.emergencyStop ? "ON" : "off"}`);
			lines.push(
				`Socket mode: ${snapshot.system.socketMode.toString(8)}  active attempts: ${snapshot.system.activeAttempts}  queued jobs: ${snapshot.system.queuedJobs}`,
			);
			break;
		case "rollout":
			lines.push(`Case: ${value(currentCase?.id)}  Mode: ${value(currentCase?.rollout)}`);
			lines.push(`Global rollout: ${snapshot.rollout}`);
			lines.push("Repository and source overrides are applied by the controller.");
			lines.push("Actions: e emergency stop, o observe, s supervised, p autonomous-pr");
			break;
		case "evidence":
			lines.push(`Case: ${value(currentCase?.id)}`);
			for (const manifest of snapshot.evidenceManifests.filter((item) => item.caseId === currentCase?.id)) {
				lines.push(
					`Manifest ${manifest.id} v${manifest.version} ${manifest.baseSha}..${manifest.candidateSha} commands=${manifest.commands.length}`,
				);
				for (const command of manifest.commands)
					lines.push(
						`  ${command.phase} ${command.executable} ${command.argv.join(" ")} expected=${command.expectedExitCode} actual=${value(command.actualExitCode)}`,
					);
			}
			for (const run of snapshot.verificationRuns.filter(
				(item) =>
					item.manifestId ===
					snapshot.evidenceManifests.find((manifest) => manifest.caseId === currentCase?.id)?.id,
			))
				lines.push(
					`Run ${run.id}: ${run.verdict} confidence=${run.confidence} replay=${run.replayHistory.join(",") || "none"}`,
				);
			lines.push("Action: R Reproduce evidence");
			break;
	}
	return lines;
}

export const renderDashboardView = buildDashboardViewLines;
