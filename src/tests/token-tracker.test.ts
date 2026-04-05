import { describe, it, expect } from "vitest";
import {
  estimateCost,
  formatLatencyStats,
  recordTokenUsage,
  getTokenUsage,
  recordToolUsage,
  getToolUsage,
  recordCompaction,
  getCompactionStats,
  type AgentTokenUsage,
} from "../utils/token-tracker.js";

describe("estimateCost", () => {
  it("returns 0 for zero usage", () => {
    const u: AgentTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requestCount: 0, latencies: [], errorCount: 0 };
    expect(estimateCost(u)).toBe(0);
  });

  it("estimates cost based on token counts", () => {
    const u: AgentTokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 0,
      requestCount: 1,
      latencies: [],
      errorCount: 0,
    };
    // 3.0 + 15.0 + 0.3 = 18.3
    expect(estimateCost(u)).toBeCloseTo(18.3, 1);
  });
});

describe("formatLatencyStats", () => {
  it("returns empty for no latencies", () => {
    const u: AgentTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requestCount: 0, latencies: [], errorCount: 0 };
    expect(formatLatencyStats(u)).toBe("");
  });

  it("formats median and p95", () => {
    const u: AgentTokenUsage = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      requestCount: 5, latencies: [1000, 2000, 3000, 4000, 5000], errorCount: 0,
    };
    const result = formatLatencyStats(u);
    expect(result).toContain("median");
    expect(result).toContain("p95");
    expect(result).toContain("3.0s median"); // median of [1,2,3,4,5] = 3
    expect(result).toContain("5.0s p95");
  });
});

describe("recordTokenUsage + getTokenUsage", () => {
  const agentId = `test-agent-${Date.now()}`;

  it("accumulates usage across calls", () => {
    recordTokenUsage(agentId, 100, 50, 10, 5, 1500);
    recordTokenUsage(agentId, 200, 100, 20, 10, 2000);
    const u = getTokenUsage(agentId);
    expect(u).toBeDefined();
    expect(u!.inputTokens).toBe(300);
    expect(u!.outputTokens).toBe(150);
    expect(u!.cacheReadTokens).toBe(30);
    expect(u!.requestCount).toBe(2);
    expect(u!.latencies).toEqual([1500, 2000]);
  });

  it("tracks errors", () => {
    const id = `err-agent-${Date.now()}`;
    recordTokenUsage(id, 0, 0, 0, 0, undefined, true);
    recordTokenUsage(id, 0, 0, 0, 0, undefined, false);
    expect(getTokenUsage(id)!.errorCount).toBe(1);
  });

  it("returns undefined for unknown agent", () => {
    expect(getTokenUsage("nonexistent")).toBeUndefined();
  });
});

describe("recordToolUsage + getToolUsage", () => {
  const agentId = `tool-agent-${Date.now()}`;

  it("tracks tool call counts", () => {
    recordToolUsage(agentId, "read_file");
    recordToolUsage(agentId, "read_file");
    recordToolUsage(agentId, "bash");
    const usage = getToolUsage(agentId);
    expect(usage).toHaveLength(2);
    expect(usage[0]).toEqual({ name: "read_file", count: 2 });
    expect(usage[1]).toEqual({ name: "bash", count: 1 });
  });

  it("returns empty for unknown agent", () => {
    expect(getToolUsage("nonexistent")).toEqual([]);
  });
});

describe("recordCompaction + getCompactionStats", () => {
  const agentId = `compact-agent-${Date.now()}`;

  it("tracks successes and failures", () => {
    recordCompaction(agentId, true);
    recordCompaction(agentId, true);
    recordCompaction(agentId, false);
    const stats = getCompactionStats(agentId);
    expect(stats).toBeDefined();
    expect(stats!.successes).toBe(2);
    expect(stats!.failures).toBe(1);
  });

  it("returns undefined for unknown agent", () => {
    expect(getCompactionStats("nonexistent")).toBeUndefined();
  });
});
