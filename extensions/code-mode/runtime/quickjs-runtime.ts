import { PiQuickJsRuntime } from "@babariviere/code-mode/host-pi";
import { piBashExitMetadata } from "../core/pi-bash-error.ts";
import type {
	PiSandboxOptions as SpindleSandboxOptions,
	SpindleSandboxResult,
	SpindleHostCall,
	SpindleSandboxTerminationReason,
} from "@babariviere/code-mode/host-pi";
export { GUEST_SETUP } from "@babariviere/code-mode/host-pi";
export type { SpindleSandboxOptions, SpindleSandboxResult, SpindleHostCall, SpindleSandboxTerminationReason };
export class QuickJsRuntime extends PiQuickJsRuntime {
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
