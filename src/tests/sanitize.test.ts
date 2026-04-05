import { describe, it, expect } from "vitest";
import { sanitizeForUser } from "../utils/sanitize.js";

describe("sanitizeForUser", () => {
  it("redacts Slack bot tokens", () => {
    expect(sanitizeForUser("token: xoxb-1234567890-abcdefghij")).toBe("token: [REDACTED]");
  });

  it("redacts Slack app tokens", () => {
    expect(sanitizeForUser("xapp-1-A1234567890-1234567890")).toBe("[REDACTED]");
  });

  it("redacts Anthropic API keys", () => {
    expect(sanitizeForUser("key=sk-ant-abc123def456ghi789jkl")).toBe("key=[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    expect(sanitizeForUser("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("redacts absolute file paths", () => {
    const msg = "Error reading /Users/professor/secret/config.json";
    expect(sanitizeForUser(msg)).toBe("Error reading [PATH]");
  });

  it("redacts long hex tokens", () => {
    const hex = "a".repeat(40);
    expect(sanitizeForUser(`hash: ${hex}`)).toBe("hash: [TOKEN]");
  });

  it("preserves normal error messages", () => {
    const msg = "Connection timeout after 30s";
    expect(sanitizeForUser(msg)).toBe(msg);
  });

  it("handles multiple patterns in one string", () => {
    const msg = "Failed at /Users/foo/bar with token xoxb-aaaa1111bbbb2222cccc";
    const result = sanitizeForUser(msg);
    expect(result).not.toContain("/Users/");
    expect(result).not.toContain("xoxb-");
  });
});
