// Static detection lets Spindle start known orchestration programs with the
// longer agent deadline. The runtime also re-checks each host call, so a
// blocking agent ref reached through a computed path cannot fall back to the
// short executor timeout.
const BLOCKING_ORCHESTRATION_REFS = new Set(["agents.run", "agents.runAll"]);

export const isBlockingOrchestrationRef = (ref: string): boolean =>
  BLOCKING_ORCHESTRATION_REFS.has(ref);

// Match blocking guest entry points as call sites (a trailing "(").
const ORCHESTRATION_RE = /\bagents\.(?:run|runAll)\s*\(/;

export const codeUsesOrchestration = (code: string): boolean =>
  ORCHESTRATION_RE.test(code);
