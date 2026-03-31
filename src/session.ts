import type { ConversationSession } from "./types.js";

const MAX_MESSAGES_PER_SESSION = 100;

export class SessionStore {
  private sessions = new Map<string, ConversationSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private ttlMs: number) {
    this.cleanupTimer = setInterval(() => this.evictStale(), 5 * 60 * 1000);
  }

  static deriveKey(channel: string, ts: string, threadTs?: string): string {
    // DMs: single continuous conversation regardless of threading
    if (channel.startsWith("D")) return `dm:${channel}`;
    // Channel thread replies: scoped to thread
    if (threadTs) return `${channel}:${threadTs}`;
    // Top-level channel messages: scoped to message (becomes thread anchor)
    return `${channel}:${ts}`;
  }

  has(key: string): boolean {
    return this.sessions.has(key);
  }

  get(key: string): ConversationSession {
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        key,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.sessions.set(key, session);
    }
    session.updatedAt = Date.now();
    return session;
  }

  truncate(session: ConversationSession): void {
    if (session.messages.length <= MAX_MESSAGES_PER_SESSION) return;
    const excess = session.messages.length - MAX_MESSAGES_PER_SESSION;
    session.messages.splice(0, excess);
    while (session.messages.length > 0 && session.messages[0].role !== "user") {
      session.messages.shift();
    }
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.updatedAt > this.ttlMs) {
        this.sessions.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}
