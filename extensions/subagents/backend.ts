/** One execution path. Replacement affects new admissions, not calls already running. */
import type { RunBackend, RunContext, RunRequest, RunResult } from "./run.ts";

export class RunLauncher {
	constructor(private backend: RunBackend) {}
	selection(): Promise<{ backend: "durable" }> {
		return Promise.resolve({ backend: "durable" });
	}
	replace(backend: RunBackend): void {
		this.backend = backend;
	}
	run(requests: RunRequest[], context: RunContext): Promise<RunResult[]> {
		return this.backend(requests, context);
	}
}
