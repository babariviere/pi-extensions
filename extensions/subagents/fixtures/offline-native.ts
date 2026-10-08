/** Offline provider and native policy fixture used by the isolated worker tests. */
import { Type } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function offlineNative(pi: ExtensionAPI): Promise<void> {
	// Use native resolution, avoiding the host extension loader's compat-root alias for subpaths.
	const { fauxAssistantMessage, fauxProvider, fauxToolCall } = (await import(
		new URL("../../../node_modules/@earendil-works/pi-ai/dist/providers/faux.js", import.meta.url).href
	)) as typeof import("@earendil-works/pi-ai/providers/faux");
	const provider = fauxProvider({ tokensPerSecond: 500 });
	const count = (name: string) => {
		const file = join(process.cwd(), name);
		writeFileSync(file, String((existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1));
	};
	provider.setResponses(
		Array.from({ length: 20 }, () => (request) => {
			count("generation-count");
			const userText = JSON.stringify(request.messages.filter((message) => message.role === "user"));
			const lastUser = JSON.stringify(request.messages.filter((message) => message.role === "user").at(-1));
			if (
				!userText.includes("recover forced") &&
				!getCurrentSystemPrompt(request.messages).includes("Native prompt hook is active.")
			)
				return fauxAssistantMessage("Native prompt hook was lost");
			if (lastUser.includes("once input"))
				return fauxAssistantMessage(
					userText.includes("native-transformed")
						? `Native transformed input, user inputs: ${request.messages.filter((message) => message.role === "user").length}`
						: "Native input transformation was lost",
				);
			if (lastUser.includes("provider error"))
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Provider error: Request was rejected by the provider.",
				});
			if (lastUser.includes("memory remember")) return fauxAssistantMessage("Memory saved: cobalt-739");
			if (lastUser.includes("memory recall")) {
				const remembered = userText.includes("memory remember cobalt-739") ? "cobalt-739" : "missing";
				const prior = request.messages.filter((message) => message.role === "assistant").at(-1);
				const priorText =
					prior?.role === "assistant"
						? prior.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
						: "missing";
				return fauxAssistantMessage(
					`Memory recalled: ${remembered}; prior answer: ${priorText}; user inputs: ${request.messages.filter((message) => message.role === "user").length}`,
				);
			}
			if (userText.includes("recover model") || userText.includes("recover forced")) {
				const marker = join(process.cwd(), "model-started");
				if (
					userText.includes("recover forced") &&
					getCurrentSystemPrompt(request.messages) !== "forced native policy"
				)
					return fauxAssistantMessage("Forced native policy was lost");
				if (!existsSync(marker)) {
					writeFileSync(marker, "started");
					return fauxAssistantMessage("Interrupted model partial. ".repeat(10_000));
				}
				return fauxAssistantMessage(
					`Recovered Harness answer, user inputs: ${request.messages.filter((message) => message.role === "user").length}`,
				);
			}
			const toolResult = [...request.messages].reverse().find((message) => message.role === "toolResult");
			if (lastUser.includes("directory probe")) {
				const reversed = [...request.messages].reverse();
				const inputIndex = reversed.findIndex((message) => message.role === "user");
				const probeResult = reversed.slice(0, inputIndex).find((message) => message.role === "toolResult");
				if (!getCurrentSystemPrompt(request.messages).includes("Selected directory context marker"))
					return fauxAssistantMessage("Selected directory context was lost");
				if (!probeResult)
					return fauxAssistantMessage(
						[
							fauxToolCall("codemode", {
								code: 'text(await tools.read({path:"location.txt"})); text(await tools.bash({command:"pwd"})); await tools.write({path:"child-output.txt",content:"selected cwd"});',
							}),
						],
						{ stopReason: "toolUse" },
					);
				return fauxAssistantMessage(`Directory probe: ${JSON.stringify(probeResult.content)}`);
			}
			if (userText.includes("recover store")) {
				const results = request.messages.filter((message) => message.role === "toolResult");
				if (results.length === 0)
					return fauxAssistantMessage(
						[fauxToolCall("codemode", { code: 'store("checkpoint", "persisted-value"); text("saved");' })],
						{ stopReason: "toolUse" },
					);
				if (results.length === 1) {
					const marker = join(process.cwd(), "store-saved");
					if (!existsSync(marker)) {
						writeFileSync(marker, "saved");
						return fauxAssistantMessage("Waiting after store. ".repeat(10_000));
					}
					return fauxAssistantMessage([fauxToolCall("codemode", { code: 'text(load("checkpoint"));' })], {
						stopReason: "toolUse",
					});
				}
				return fauxAssistantMessage(`Store after restart: ${JSON.stringify(toolResult)}`);
			}
			if (userText.includes("recover unsafe")) {
				if (!toolResult)
					return fauxAssistantMessage([fauxToolCall("codemode", { code: "await tools.native_effect({});" })], {
						stopReason: "toolUse",
					});
				return fauxAssistantMessage(
					`Interrupted native tool was not replayed. Effects: ${readFileSync(join(process.cwd(), "effects"), "utf8")}. ${JSON.stringify(toolResult)}`,
				);
			}
			if (!toolResult)
				return fauxAssistantMessage(
					[
						fauxToolCall("codemode", {
							code: 'text(await tools.native_echo({ value: "native pipeline" })); store("checkpoint", "saved");',
						}),
					],
					{ stopReason: "toolUse" },
				);
			const output = toolResult?.role === "toolResult" ? JSON.stringify(toolResult.content) : "missing";
			return fauxAssistantMessage(`Offline durable result: ${output}`);
		}),
	);
	pi.registerProvider(provider.provider);
	pi.on("input", (event) => {
		count("input-count");
		if (event.text === "once input") return { action: "transform", text: "once input native-transformed" };
	});
	pi.registerTool({
		name: "native_echo",
		label: "Native echo",
		description: "Offline structured native tool",
		exposure: "codemode",
		parameters: Type.Object({ value: Type.String() }),
		outputSchema: Type.Object({ echoed: Type.String() }),
		execute: async (_id, args) => ({
			content: [{ type: "text", text: args.value }],
			structuredContent: { echoed: args.value },
			details: {},
		}),
	});
	pi.registerTool({
		name: "native_effect",
		label: "Native effect",
		description: "Interruptible offline effect",
		exposure: "codemode",
		parameters: Type.Object({}),
		execute: async (_id, _args, signal) => {
			const file = join(process.cwd(), "effects");
			writeFileSync(file, String((existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1));
			return new Promise<never>((_resolve, reject) => {
				if (signal?.aborted) reject(new Error("interrupted"));
				else signal?.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
			});
		},
	});
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections.offline_test = "Native prompt hook is active.";
		if (event.prompt.includes("recover forced")) {
			const file = join(process.cwd(), "prompt-starts");
			writeFileSync(file, String((existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1));
			return { systemPrompt: "forced native policy" };
		}
	});
	pi.on("tool_result", (event) => {
		if (event.toolName === "native_echo")
			return {
				content: [{ type: "text", text: "native result transformed" }],
				structuredContent: { echoed: "native hook" },
			};
	});
}
