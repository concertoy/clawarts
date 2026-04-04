/**
 * Cumulative token usage tracker per agent.
 * Updated after each agent reply, exposed via status tool.
 */

export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requestCount: number;
}

/**
 * Rough cost estimation per 1M tokens (USD).
 * Defaults to Claude Sonnet 4 pricing. Good enough for a quick dashboard —
 * not billing-grade. A lazy professor just wants a ballpark.
 */
const DEFAULT_INPUT_COST_PER_M = 3.0;
const DEFAULT_OUTPUT_COST_PER_M = 15.0;
const DEFAULT_CACHE_READ_COST_PER_M = 0.3;

/** Estimate cumulative cost in USD for an agent's token usage. */
export function estimateCost(u: AgentTokenUsage): number {
  return (
    (u.inputTokens / 1_000_000) * DEFAULT_INPUT_COST_PER_M +
    (u.outputTokens / 1_000_000) * DEFAULT_OUTPUT_COST_PER_M +
    (u.cacheReadTokens / 1_000_000) * DEFAULT_CACHE_READ_COST_PER_M
  );
}

const usage = new Map<string, AgentTokenUsage>();

/** Record token usage for an agent (called after each getReply). */
export function recordTokenUsage(
  agentId: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
): void {
  const prev = usage.get(agentId) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    requestCount: 0,
  };
  usage.set(agentId, {
    inputTokens: prev.inputTokens + input,
    outputTokens: prev.outputTokens + output,
    cacheReadTokens: prev.cacheReadTokens + cacheRead,
    cacheCreationTokens: prev.cacheCreationTokens + cacheCreation,
    requestCount: prev.requestCount + 1,
  });
}

/** Get cumulative token usage for an agent. */
export function getTokenUsage(agentId: string): AgentTokenUsage | undefined {
  return usage.get(agentId);
}
