/** Advisory milestones are deliberately non-blocking and independent of provider quotas. */
export const SESSION_ADVISORY_INTERVAL = 100;

export const sessionAdvisoryCheckpoint = (turns: number, lastCheckpoint: number): number | undefined => {
	const checkpoint = Math.floor(turns / SESSION_ADVISORY_INTERVAL) * SESSION_ADVISORY_INTERVAL;
	return checkpoint >= SESSION_ADVISORY_INTERVAL && checkpoint > lastCheckpoint ? checkpoint : undefined;
};

export const completedAssistantTurns = (branch: readonly { type: string; message?: { role?: string } }[]): number =>
	branch.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").length;

const formatTokens = (tokens: number): string =>
	tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1_000)}k`;

export const sessionAdvisory = (options: { turns: number; contextTokens?: number; activeAgents: number }): string => {
	const { turns, contextTokens, activeAgents } = options;
	const context = contextTokens && contextTokens > 0 ? `; latest context ~${formatTokens(contextTokens)} tokens` : "";
	const children = activeAgents > 0 ? `; ${activeAgents} active subagent${activeAgents === 1 ? "" : "s"}` : "";
	return `This session has ${turns} assistant turns${context}${children}. At the next task boundary, consider a short handoff and a fresh session (/new). This is a context advisory, not a usage limit.`;
};
