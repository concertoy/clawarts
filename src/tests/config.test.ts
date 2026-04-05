import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveEnvRef } from "../config.js";

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
