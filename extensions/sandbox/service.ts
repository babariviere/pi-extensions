/** Optional policy hooks for tools that do not use Pi's core file/shell operations. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SANDBOX_WRAP_COMMAND_EVENT = "sandbox:wrap-command";
export const SANDBOX_WRITE_GUARD_EVENT = "sandbox:guard-write";
export interface WrapCommandRequest {
	command: string;
	result?: Promise<string>;
}
export interface WriteGuardRequest {
	path: string;
	error?: Error;
}

/** Background jobs require the sandbox extension, even when its policy is off. */
export function sandboxWrapCommand(pi: ExtensionAPI, command: string): Promise<string> {
	const request: WrapCommandRequest = { command };
	pi.events.emit(SANDBOX_WRAP_COMMAND_EVENT, request);
	return (
		request.result ??
		Promise.reject(new Error("Background jobs require the sandbox extension to provide shell policy"))
	);
}
/** Ordinary file changes remain available when the optional sandbox extension is absent. */
export function sandboxGuardWrite(pi: ExtensionAPI, path: string): void {
	const request: WriteGuardRequest = { path };
	pi.events.emit(SANDBOX_WRITE_GUARD_EVENT, request);
	// Pi's event bus isolates listener exceptions. Carry policy failures back
	// explicitly rather than relying on an exception escaping emit().
	if (request.error) throw request.error;
}
