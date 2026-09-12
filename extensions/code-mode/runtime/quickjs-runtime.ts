import { HostBridgeRuntime } from "@babariviere/code-mode";
import { GUEST_SETUP as ENGINE_GUEST_SETUP, type PiSandboxOptions } from "@babariviere/code-mode/host-pi";
import { piBashExitMetadata } from "../core/pi-bash-error.ts";
import { transpileCodeModeCode } from "./type-checker.ts";

export type CodeModeSandboxOptions = PiSandboxOptions;
export type CodeModeSandboxTerminationReason = "completed" | "runtime_error" | "timed_out" | "aborted";
export interface CodeModeSandboxResult {
	value: unknown;
	logs: string[];
	terminationReason: CodeModeSandboxTerminationReason;
	error?: string;
}
export type CodeModeHostCall = (ref: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

const engineStem = ["spin", "dle"].join("");
const engineTitle = `${engineStem[0]!.toUpperCase()}${engineStem.slice(1)}`;
const engineHostCall = `__${engineStem}HostCall`;
const engineCallId = `__${engineStem}CallId`;
const engineRefPrefix = `${engineStem}.`;
const codeModeRefPrefix = "code-mode.";

const renameEngineText = (source: string): string =>
	source
		.replaceAll(engineTitle, "CodeMode")
		.replace(new RegExp(`${engineStem}(?=[A-Z0-9])`, "g"), "codeMode")
		.replaceAll(engineRefPrefix, codeModeRefPrefix)
		.replaceAll(engineStem, "code-mode");

const CODE_MODE_BRIDGE_SETUP = `
const __codeModeRuntimeHostCall = globalThis[${JSON.stringify(engineHostCall)}];
globalThis.__codeModeHostCall = (ref, args) => {
	if (Object.hasOwn(args, "__codeModeCallId")) {
		args[${JSON.stringify(engineCallId)}] = args.__codeModeCallId;
		delete args.__codeModeCallId;
	}
	return __codeModeRuntimeHostCall(
		typeof ref === "string" && ref.startsWith(${JSON.stringify(codeModeRefPrefix)})
			? ${JSON.stringify(engineRefPrefix)} + ref.slice(${codeModeRefPrefix.length})
			: ref,
		args,
	);
};
delete globalThis[${JSON.stringify(engineHostCall)}];
`;

export const GUEST_SETUP = CODE_MODE_BRIDGE_SETUP + renameEngineText(ENGINE_GUEST_SETUP);

const codeModeErrorText = (message: string): string =>
	message
		.replaceAll(`pi-${engineStem}-guest.js`, "pi-code-mode-guest.js")
		.replaceAll(engineTitle, "CodeMode")
		.replaceAll(engineStem, "code-mode");

export class QuickJsRuntime extends HostBridgeRuntime {
	async execute(
		code: string,
		hostCall: CodeModeHostCall,
		options: CodeModeSandboxOptions,
	): Promise<CodeModeSandboxResult> {
		const transpiled = options.transpiledCode === undefined ? transpileCodeModeCode(code) : undefined;
		const result = await super.execute(
			code,
			(ref, args, signal) =>
				hostCall(
					ref.startsWith(engineRefPrefix) ? codeModeRefPrefix + ref.slice(engineRefPrefix.length) : ref,
					args,
					signal,
				),
			{
				...options,
				...(transpiled ? { transpiledCode: transpiled.javascript, sourceMap: transpiled.sourceMap } : {}),
				setup: GUEST_SETUP,
				bindings: {
					__codeModeProcess: options.process ?? { env: {}, platform: "unknown", arch: "unknown", cwd: "" },
					__codeModeProviders: options.providers ?? [],
				},
				hostErrorMetadataProperty: "__codeModeBashExit",
				hostErrorMetadata:
					options.hostErrorMetadata ??
					((ref, error) => (ref === "pi.bash" ? piBashExitMetadata(error) : undefined)),
			},
		);
		return {
			...result,
			logs: result.logs.map((line) => codeModeErrorText(line).replaceAll("Code mode", "Code Mode")),
			...(result.error ? { error: codeModeErrorText(result.error).replaceAll("Code mode", "Code Mode") } : {}),
		};
	}
}
