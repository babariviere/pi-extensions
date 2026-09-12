/**
 * Child-side extension injected into a subagent's `pi` process via `--extension`,
 * loaded only when the agent definition declares a `sandbox:` mode.
 *
 * Its sole job is to register the `--{@link SANDBOX_MODE_FLAG}` CLI flag so the
 * child accepts the arg without failing startup with "Unknown option". Spindle
 * (loaded in the child as a package extension) reads the value off argv rather
 * than via `getFlag`, because `getFlag` only resolves flags the reading
 * extension itself registered and pi rejects the same flag name registered
 * twice.
 *
 * There is no result tool: a subagent's result is its final assistant message,
 * recovered from the child transcript by the parent (see `run.ts`
 * `readLastAssistantText`). This is more reliable than a `submit_result` tool
 * the agent must remember to call, especially in full code mode where such a
 * tool is captured and hidden behind the `extensions.*` namespace.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { SANDBOX_MODE_FLAG } from "./constants.ts";

export default function (pi: ExtensionAPI) {
	pi.registerFlag(SANDBOX_MODE_FLAG, {
		type: "string",
		description: "Sandbox mode floor applied inside Spindle for this subagent (set by the parent).",
	});
}
