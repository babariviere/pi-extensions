/**
 * PORTED from upstream `src/core/core-override-guidance.ts`.
 *
 * An extension may override a Pi core tool by exact name (this repository's own
 * `tool-substitute` extension does). In full code mode the override is reachable
 * only as `pi.<name>` inside a Spindle program, so its authored prompt text is
 * never presented as a separate extension tool. Append that guidance instead of
 * losing it.
 */

import type { CapturedToolCatalog } from "../capture/catalog.ts";
import { PI_CORE_TOOL_NAMES } from "./pi-tools.ts";

export const coreOverridePromptGuidance = (catalog: Pick<CapturedToolCatalog, "get">): string => {
	const sections: string[] = [];
	for (const name of PI_CORE_TOOL_NAMES) {
		const entry = catalog.get(name);
		if (!entry) continue;
		const lines: string[] = [];
		const definition = entry.definition as {
			promptSnippet?: string;
			promptGuidelines?: string[];
		};
		if (definition.promptSnippet) {
			lines.push(`Additional guidance for \`pi.${name}\`: ${definition.promptSnippet}`);
		}
		const guidelines = definition.promptGuidelines ?? [];
		if (guidelines.length > 0) {
			lines.push(`Guidelines for \`pi.${name}\`:`);
			lines.push(...guidelines.map((guideline) => `- ${guideline}`));
		}
		if (lines.length > 0) sections.push(lines.join("\n"));
	}
	return sections.length > 0 ? `\n\nEffective compatible core override guidance:\n${sections.join("\n")}` : "";
};
