import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveEnvRef, AGENT_DEFAULTS, DEFAULT_MODELS } from "../config.js";

describe("resolveEnvRef", () => {
  const ENV_KEY = "CLAWARTS_TEST_TOKEN_XYZ";
  const ENV_VAL = "xoxb-test-token-123";

  beforeEach(() => {
    process.env[ENV_KEY] = ENV_VAL;
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("resolves $VAR syntax", () => {
    expect(resolveEnvRef(`$${ENV_KEY}`)).toBe(ENV_VAL);
  });

  it("resolves ${VAR} syntax", () => {
    expect(resolveEnvRef(`\${${ENV_KEY}}`)).toBe(ENV_VAL);
  });

  it("passes through literal strings", () => {
    expect(resolveEnvRef("xoxb-literal-token")).toBe("xoxb-literal-token");
  });

  it("throws for unset env var with $ syntax", () => {
    expect(() => resolveEnvRef("$NONEXISTENT_VAR_12345")).toThrow("not set");
  });

  it("throws for unset env var with ${} syntax", () => {
    expect(() => resolveEnvRef("${NONEXISTENT_VAR_12345}")).toThrow("not set");
  });

  it("does not resolve partial $ in middle of string", () => {
    expect(resolveEnvRef("hello$world")).toBe("hello$world");
  });
});

describe("AGENT_DEFAULTS", () => {
  it("has valid provider", () => {
    expect(["openai-codex", "anthropic-claude"]).toContain(AGENT_DEFAULTS.provider);
  });

  it("has positive maxTokens", () => {
    expect(AGENT_DEFAULTS.maxTokens).toBeGreaterThan(0);
  });

  it("has positive sessionTtlMinutes", () => {
    expect(AGENT_DEFAULTS.sessionTtlMinutes).toBeGreaterThan(0);
  });
});

describe("DEFAULT_MODELS", () => {
  it("has a model for each provider", () => {
    expect(DEFAULT_MODELS["openai-codex"]).toBeDefined();
    expect(DEFAULT_MODELS["anthropic-claude"]).toBeDefined();
  });

  it("claude model starts with claude-", () => {
    expect(DEFAULT_MODELS["anthropic-claude"]).toMatch(/^claude-/);
  });
});
