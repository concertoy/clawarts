import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runDiagnostics } from "../diagnostics.js";
import type { AgentConfig } from "../types.js";

// Capture console.warn calls to verify diagnostics output
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    provider: "anthropic-claude",
    model: "claude-sonnet-4-5-20250514",
    maxTokens: 8192,
    systemPrompt: "test",
    skillsDirs: [],
    sessionTtlMinutes: 60,
    workspaceDir: "/tmp/clawarts-test-nonexistent",
    slackBotToken: "xoxb-test-1",
    slackAppToken: "xapp-test-1",
    ...overrides,
  };
}

describe("runDiagnostics", () => {
  beforeEach(() => {
    warnSpy.mockClear();
    logSpy.mockClear();
  });

  afterEach(() => {
    warnSpy.mockClear();
    logSpy.mockClear();
  });

  it("runs without error on valid config", () => {
    expect(() => runDiagnostics([makeConfig()])).not.toThrow();
  });

  it("warns about invalid agent ID characters", () => {
    runDiagnostics([makeConfig({ id: "BAD AGENT!" })]);
    const warnings = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0]));
    expect(warnings.some((w) => w.includes("lowercase alphanumeric"))).toBe(true);
  });

  it("warns about student without disallowedTools", () => {
    runDiagnostics([
      makeConfig({ id: "tutor" }),
      makeConfig({ id: "student", linkedTutor: "tutor", slackBotToken: "xoxb-test-2", slackAppToken: "xapp-test-2" }),
    ]);
    const warnings = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0]));
    expect(warnings.some((w) => w.includes("disallowedTools"))).toBe(true);
  });

  it("warns about no allowedUsers", () => {
    runDiagnostics([makeConfig()]);
    const warnings = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0]));
    expect(warnings.some((w) => w.includes("allowedUsers"))).toBe(true);
  });

  it("warns about high maxToolIterations", () => {
    runDiagnostics([makeConfig({ maxToolIterations: 50 })]);
    const warnings = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0]));
    expect(warnings.some((w) => w.includes("maxToolIterations"))).toBe(true);
  });
});
