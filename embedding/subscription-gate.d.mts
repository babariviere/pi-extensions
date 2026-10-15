/** Host-owned per-chat policy shared by parent and subagent workers. */
export class SubscriptionGate {
	constructor(path?: string, intervalMs?: number);
	wait(piProvider: string | undefined, signal?: AbortSignal): Promise<void>;
}
