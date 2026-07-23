/**
 * The run-backend seam. `selectBackend` is the one place that knows both
 * adapters exist and picks between them by environment: live herdr panes when
 * running inside herdr, otherwise headless `pi` child processes. Callers depend
 * only on the `RunBackend` interface (see run.ts), not on either adapter.
 */

import { runHeadlessBatch } from "./headless.ts";
import { isInHerdr } from "./herdr.ts";
import { runInHerdr } from "./herdr-backend.ts";
import { type RunBackend } from "./run.ts";

export function selectBackend(): RunBackend {
	return isInHerdr() ? runInHerdr : runHeadlessBatch;
}
