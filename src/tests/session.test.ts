import { describe, it, expect } from "vitest";
import { SessionStore } from "../session.js";

describe("SessionStore", () => {
  describe("deriveKey", () => {
    it("uses dm: prefix for DM channels", () => {
      expect(SessionStore.deriveKey("D123ABC", "1234.5678")).toBe("dm:D123ABC");
    });

    it("uses channel:threadTs for thread replies", () => {
      expect(SessionStore.deriveKey("C123", "1234.5", "1000.1")).toBe("C123:1000.1");
    });

    it("uses channel:ts for top-level messages", () => {
      expect(SessionStore.deriveKey("C123", "1234.5")).toBe("C123:1234.5");
    });

    it("ignores threadTs for DMs", () => {
      expect(SessionStore.deriveKey("D999", "1.0", "2.0")).toBe("dm:D999");
    });
  });

  describe("get/has", () => {
    it("auto-creates sessions on get", () => {
      const store = new SessionStore(60_000);
      const session = store.get("test-key");
      expect(session.key).toBe("test-key");
      expect(session.messages).toEqual([]);
    });

    it("has returns false for unknown keys", () => {
      const store = new SessionStore(60_000);
      expect(store.has("unknown")).toBe(false);
    });

    it("has returns true after get", () => {
      const store = new SessionStore(60_000);
      store.get("key1");
      expect(store.has("key1")).toBe(true);
    });

    it("returns same session on repeated get", () => {
      const store = new SessionStore(60_000);
      const s1 = store.get("key");
      s1.messages.push({ role: "user", content: "hi" });
      const s2 = store.get("key");
      expect(s2.messages).toHaveLength(1);
    });
  });

  describe("size", () => {
    it("tracks session count", () => {
      const store = new SessionStore(60_000);
      expect(store.size).toBe(0);
      store.get("a");
      store.get("b");
      expect(store.size).toBe(2);
    });
  });

  describe("clearAll", () => {
    it("clears all session messages", () => {
      const store = new SessionStore(60_000);
      const s1 = store.get("a");
      s1.messages.push({ role: "user", content: "hello" });
      const s2 = store.get("b");
      s2.messages.push({ role: "user", content: "world" }, { role: "assistant", content: "hi" });

      const result = store.clearAll();
      expect(result.sessions).toBe(2);
      expect(result.messages).toBe(3);
      expect(s1.messages).toHaveLength(0);
      expect(s2.messages).toHaveLength(0);
    });
  });

  describe("listSessions", () => {
    it("lists sessions with metadata", () => {
      const store = new SessionStore(60_000);
      const s = store.get("key1");
      s.messages.push({ role: "user", content: "test" });

      const list = store.listSessions();
      expect(list).toHaveLength(1);
      expect(list[0].key).toBe("key1");
      expect(list[0].messageCount).toBe(1);
    });
  });

  describe("getMessages", () => {
    it("returns read-only copy of messages", () => {
      const store = new SessionStore(60_000);
      const s = store.get("key");
      s.messages.push({ role: "user", content: "hello" });

      const msgs = store.getMessages("key");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toEqual({ role: "user", content: "hello" });
    });

    it("returns empty array for unknown key", () => {
      const store = new SessionStore(60_000);
      expect(store.getMessages("unknown")).toEqual([]);
    });
  });

  describe("truncate", () => {
    it("removes excess messages from the front", () => {
      const store = new SessionStore(60_000);
      const s = store.get("trunc");
      // Add 105 messages (exceeds MAX_MESSAGES_PER_SESSION = 100)
      for (let i = 0; i < 105; i++) {
        s.messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` });
      }
      store.truncate(s);
      expect(s.messages.length).toBeLessThanOrEqual(100);
    });

    it("does not truncate when under limit", () => {
      const store = new SessionStore(60_000);
      const s = store.get("short");
      s.messages.push({ role: "user", content: "hello" });
      s.messages.push({ role: "assistant", content: "hi" });
      store.truncate(s);
      expect(s.messages.length).toBe(2);
    });

    it("ensures first message after truncation is from user", () => {
      const store = new SessionStore(60_000);
      const s = store.get("role-fix");
      // Start with assistant, then alternate — after truncation, first should be user
      for (let i = 0; i < 110; i++) {
        s.messages.push({ role: i % 2 === 0 ? "assistant" : "user", content: `msg ${i}` });
      }
      store.truncate(s);
      expect(s.messages[0].role).toBe("user");
    });
  });

  describe("destroy", () => {
    it("clears sessions and timer", () => {
      const store = new SessionStore(60_000);
      store.get("a");
      store.get("b");
      store.destroy();
      expect(store.size).toBe(0);
    });
  });
});
