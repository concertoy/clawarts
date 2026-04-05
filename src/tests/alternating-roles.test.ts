import { describe, it, expect } from "vitest";
import { ensureAlternatingRoles } from "../agent.js";
import type { ProviderMessage } from "../provider.js";

function user(content: string): ProviderMessage {
  return { role: "user", content };
}
function assistant(content: string): ProviderMessage {
  return { role: "assistant", content };
}

describe("ensureAlternatingRoles", () => {
  it("merges consecutive user messages", () => {
    const msgs: ProviderMessage[] = [user("a"), user("b"), assistant("c")];
    ensureAlternatingRoles(msgs);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "user", content: "a\n\nb" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "c" });
  });

  it("merges three consecutive user messages", () => {
    const msgs: ProviderMessage[] = [user("a"), user("b"), user("c")];
    ensureAlternatingRoles(msgs);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: "user", content: "a\n\nb\n\nc" });
  });

  it("prepends user message if first is assistant", () => {
    const msgs: ProviderMessage[] = [assistant("hi"), user("hello")];
    ensureAlternatingRoles(msgs);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[2].role).toBe("user");
  });

  it("leaves already-alternating messages unchanged", () => {
    const msgs: ProviderMessage[] = [user("a"), assistant("b"), user("c")];
    ensureAlternatingRoles(msgs);
    expect(msgs).toHaveLength(3);
  });

  it("handles empty array", () => {
    const msgs: ProviderMessage[] = [];
    ensureAlternatingRoles(msgs);
    expect(msgs).toHaveLength(0);
  });

  it("handles single user message", () => {
    const msgs: ProviderMessage[] = [user("only")];
    ensureAlternatingRoles(msgs);
    expect(msgs).toHaveLength(1);
  });

  it("merges consecutive assistant messages", () => {
    const msgs: ProviderMessage[] = [user("a"), assistant("b"), assistant("c"), user("d")];
    ensureAlternatingRoles(msgs);
    expect(msgs).toHaveLength(3);
    expect(msgs[1]).toEqual({ role: "assistant", content: "b\n\nc" });
  });

  it("does not merge tool_result with user", () => {
    const msgs: ProviderMessage[] = [
      user("call tool"),
      { role: "tool_result", callId: "1", name: "bash", output: "ok" },
    ];
    ensureAlternatingRoles(msgs);
    // tool_result is not role="user", so no merge
    expect(msgs).toHaveLength(2);
  });
});
