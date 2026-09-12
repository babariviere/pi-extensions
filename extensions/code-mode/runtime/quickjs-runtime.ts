import { RichQuickJsRuntime } from "@babariviere/code-mode";
import { piBashExitMetadata } from "../core/pi-bash-error.ts";
import type {
	SpindleSandboxOptions,
	SpindleSandboxResult,
	SpindleHostCall,
	SpindleSandboxTerminationReason,
} from "@babariviere/code-mode";
export { GUEST_SETUP } from "@babariviere/code-mode";
export type { SpindleSandboxOptions, SpindleSandboxResult, SpindleHostCall, SpindleSandboxTerminationReason };
export class QuickJsRuntime extends RichQuickJsRuntime {
	async execute(
		code: string,
		hostCall: SpindleHostCall,
		options: SpindleSandboxOptions,
	): Promise<SpindleSandboxResult> {
		return super.execute(code, hostCall, {
			...options,
			hostErrorMetadata:
				options.hostErrorMetadata ?? ((ref, error) => (ref === "pi.bash" ? piBashExitMetadata(error) : undefined)),
		});
	}
}
