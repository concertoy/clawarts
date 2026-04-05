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
  /** Recent request latencies in ms (last 50). */
  latencies: number[];
  errorCount: number;
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

const MAX_LATENCIES = 50;

/** Record token usage for an agent (called after each getReply). */
export function recordTokenUsage(
  agentId: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
  latencyMs?: number,
  isError?: boolean,
): void {
  const prev = usage.get(agentId) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    requestCount: 0,
    latencies: [],
    errorCount: 0,
  };
  const latencies = prev.latencies;
  if (latencyMs != null) {
    latencies.push(latencyMs);
    if (latencies.length > MAX_LATENCIES) latencies.shift();
  }
  usage.set(agentId, {
    inputTokens: prev.inputTokens + input,
    outputTokens: prev.outputTokens + output,
    cacheReadTokens: prev.cacheReadTokens + cacheRead,
    cacheCreationTokens: prev.cacheCreationTokens + cacheCreation,
    requestCount: prev.requestCount + 1,
    latencies,
    errorCount: prev.errorCount + (isError ? 1 : 0),
  });
}

/** Get median of a sorted array. */
function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Get p95 of a sorted array. */
function p95(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)];
}

/** Format latency stats for display. */
export function formatLatencyStats(u: AgentTokenUsage): string {
  if (u.latencies.length === 0) return "";
  const sorted = [...u.latencies].sort((a, b) => a - b);
  const med = (median(sorted) / 1000).toFixed(1);
  const p = (p95(sorted) / 1000).toFixed(1);
  return `latency: ${med}s median, ${p}s p95`;
}

/** Get cumulative token usage for an agent. */
export function getTokenUsage(agentId: string): AgentTokenUsage | undefined {
  return usage.get(agentId);
}

// ─── Tool usage tracking ─────────────────────────────────────────────

const toolUsage = new Map<string, Map<string, number>>(); // agentId → toolName → count

/** Record a tool invocation. */
export function recordToolUsage(agentId: string, toolName: string): void {
  let agent = toolUsage.get(agentId);
  if (!agent) {
    agent = new Map();
    toolUsage.set(agentId, agent);
  }
  agent.set(toolName, (agent.get(toolName) ?? 0) + 1);
}

/** Get tool usage counts for an agent (sorted by count desc). */
export function getToolUsage(agentId: string): { name: string; count: number }[] {
  const agent = toolUsage.get(agentId);
  if (!agent) return [];
  return [...agent.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

// ─── Compaction tracking ────────────────────────────────────────────

const compactionStats = new Map<string, { successes: number; failures: number }>();

/** Record a compaction attempt (success or failure). */
export function recordCompaction(agentId: string, success: boolean): void {
  const prev = compactionStats.get(agentId) ?? { successes: 0, failures: 0 };
  if (success) prev.successes++;
  else prev.failures++;
  compactionStats.set(agentId, prev);
}

/** Get compaction stats for an agent. */
export function getCompactionStats(agentId: string): { successes: number; failures: number } | undefined {
  return compactionStats.get(agentId);
}
