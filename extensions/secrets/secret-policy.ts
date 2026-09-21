/**
 * secret-policy.ts — which tools may expand a secret reference, and how.
 *
 * Split out of index.ts so the rules are testable without an agent session:
 * this is the whole security boundary, and it is the part worth pinning down.
 *
 * The event input is mutated in place, which is the contract pi documents for
 * patching tool arguments (see ToolCallEvent in the SDK).
 */

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { hasMaskArtifact, type HydrateResult, type SecretRefRegistry } from "./secret-ref.ts";

export type PolicyOutcome = { block: false; notify?: string } | { block: true; reason: string };

const ALLOW: PolicyOutcome = { block: false };

/**
 * Tools that carry other tool calls rather than performing one themselves.
 *
 * Code Mode runs pi tools nested and replays `tool_call` for each, so a ref inside
 * its code payload is hydrated at the inner write and must not be refused here.
 * Refusing it would make refs unusable in full-code mode, where Code Mode is the
 * only path to the file tools.
 */
const PASSTHROUGH_TOOLS = new Set(["code_mode"]);

function blockUnresolved(unresolved: string[], where: string): PolicyOutcome {
	return {
		block: true,
		reason: [
			`Unknown secret reference in ${where}: ${unresolved.join(", ")}.`,
			"References are minted by this extension and are only valid in the session that produced them.",
			"Use a reference exactly as it appeared in tool output, or <secret:NAME> for a secret listed in the system prompt.",
		].join(" "),
	};
}

function blockArtifact(where: string): PolicyOutcome {
	return {
		block: true,
		reason: [
			`Masked secret value in ${where}.`,
			"Writing a mask destroys the real secret.",
			"Use the <secret:...> reference instead; it expands to the real value on write.",
		].join(" "),
	};
}

function expansionNotice(names: string[], path: string): string | undefined {
	const unique = [...new Set(names)];
	return unique.length > 0 ? `Expanded ${unique.join(", ")} into ${path}` : undefined;
}

/** Serialize arbitrary tool input for a ref scan. Undefined when unserializable. */
function stringifyInput(input: unknown): string | undefined {
	try {
		return JSON.stringify(input) ?? "";
	} catch {
		return undefined;
	}
}

/**
 * Hydrate only file-content positions in a V4A patch. Paths and control lines
 * deliberately stay outside the hydration boundary, matching write/edit where
 * path arguments are never expanded.
 */
function hydrateApplyPatch(patch: string, registry: SecretRefRegistry): HydrateResult {
	const parts = patch.split(/(\r\n|\r|\n)/u);
	const resolved: HydrateResult["resolved"] = [];
	const unresolved: string[] = [];
	let action: "add" | "update" | undefined;

	const hydrateLine = (line: string, prefix: string): string => {
		const hydrated = registry.hydrate(line, "value");
		resolved.push(...hydrated.resolved);
		unresolved.push(...hydrated.unresolved);
		// A secret can contain newlines. Repeat the patch marker so every expanded
		// line remains part of the same add/update hunk.
		return hydrated.text.replace(/\r\n|\r|\n/gu, (ending) => `${ending}${prefix}`);
	};

	for (let index = 0; index < parts.length; index += 2) {
		const line = parts[index] ?? "";
		const marker = line.trim();
		if (/^\*\*\* Add File: /u.test(marker)) action = "add";
		else if (/^\*\*\* Update File: /u.test(marker)) action = "update";
		else if (/^\*\*\* Delete File: /u.test(marker) || marker === "*** End Patch") action = undefined;
		else if (action === "add" && line.startsWith("+")) {
			parts[index] = `+${hydrateLine(line.slice(1), "+")}`;
			continue;
		} else if (action === "update" && line.startsWith("@@ ")) {
			// Anchor text names a line in the file. If a multiline value appears
			// here, turn its remaining lines into ordinary context lines.
			parts[index] = `@@ ${hydrateLine(line.slice(3), " ")}`;
			continue;
		} else if (action === "update" && [" ", "+", "-"].includes(line[0] ?? "")) {
			const prefix = line[0] ?? "";
			parts[index] = `${prefix}${hydrateLine(line.slice(1), prefix)}`;
			continue;
		}

		// A reference in a path, move destination, or control line must not
		// become a value-bearing filesystem argument. Escaped literal refs are inert.
		unresolved.push(...registry.scan(line));
	}

	return { text: parts.join(""), resolved, unresolved: [...new Set(unresolved)] };
}

/**
 * Apply the hydration policy to a tool call, mutating `event.input` in place.
 *
 * The caller is responsible for having registered the env-backed secrets first,
 * otherwise authoring refs cannot resolve.
 */
export function applySecretPolicy(event: ToolCallEvent, registry: SecretRefRegistry): PolicyOutcome {
	if (isToolCallEventType("bash", event)) {
		// Never expand a value into a command line: it would land in the process
		// table, the shell history, and the session transcript. Point at the env var
		// instead, which the fnox export defines.
		const hydrated = registry.hydrate(event.input.command, "env");
		if (hydrated.unresolved.length > 0) {
			return {
				block: true,
				reason: [
					`Secret reference cannot be used here: ${hydrated.unresolved.join(", ")}.`,
					"In bash, only secrets backed by an environment variable work, and only outside single quotes; use $NAME directly.",
					"A reference for a secret merely detected in a file has no variable behind it.",
				].join(" "),
			};
		}
		event.input.command = hydrated.text;
		return ALLOW;
	}

	if (isToolCallEventType("write", event)) {
		const where = `write to ${event.input.path}`;
		if (hasMaskArtifact(event.input.content)) return blockArtifact(where);
		const hydrated = registry.hydrate(event.input.content, "value");
		if (hydrated.unresolved.length > 0) return blockUnresolved(hydrated.unresolved, where);
		event.input.content = hydrated.text;
		const notify = expansionNotice(
			hydrated.resolved.map((entry) => entry.names[0] ?? entry.label),
			event.input.path,
		);
		return { block: false, notify };
	}

	if (isToolCallEventType("edit", event)) {
		const where = `edit of ${event.input.path}`;
		const expanded: string[] = [];
		for (const edit of event.input.edits) {
			if (hasMaskArtifact(edit.newText)) return blockArtifact(where);

			// oldText matters as much as newText: the model saw refs when it read the
			// file, so the match has to be made against the real content on disk.
			const oldText = registry.hydrate(edit.oldText, "value");
			if (oldText.unresolved.length > 0) return blockUnresolved(oldText.unresolved, where);
			const newText = registry.hydrate(edit.newText, "value");
			if (newText.unresolved.length > 0) return blockUnresolved(newText.unresolved, where);

			edit.oldText = oldText.text;
			edit.newText = newText.text;
			expanded.push(...newText.resolved.map((entry) => entry.names[0] ?? entry.label));
		}
		return { block: false, notify: expansionNotice(expanded, event.input.path) };
	}

	if (event.toolName === "applyPatch") {
		const input = event.input as unknown as { patch?: unknown };
		if (typeof input.patch !== "string") return ALLOW;
		const where = "applyPatch input";
		if (hasMaskArtifact(input.patch)) return blockArtifact(where);
		const hydrated = hydrateApplyPatch(input.patch, registry);
		if (hydrated.unresolved.length > 0) return blockUnresolved(hydrated.unresolved, where);
		input.patch = hydrated.text;
		return {
			block: false,
			notify: expansionNotice(
				hydrated.resolved.map((entry) => entry.names[0] ?? entry.label),
				"applyPatch",
			),
		};
	}

	if (PASSTHROUGH_TOOLS.has(event.toolName)) return ALLOW;

	// Every other tool is outside the hydration boundary. A ref reaching one is
	// either a mistake or a transplant attempt (copying a ref into a URL to get a
	// value the model never saw exfiltrated), so it is refused, not expanded.
	const serialized = stringifyInput(event.input);
	if (serialized === undefined) {
		return {
			block: true,
			reason: `Cannot inspect ${event.toolName} arguments for secret references, so the call is refused.`,
		};
	}
	const found = registry.scan(serialized);
	if (found.length > 0) {
		return {
			block: true,
			reason: [
				`Secret reference passed to ${event.toolName}: ${found.join(", ")}.`,
				"References only expand in write, edit, and applyPatch. Nothing else receives the value.",
			].join(" "),
		};
	}
	return ALLOW;
}
