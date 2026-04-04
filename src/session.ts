import fs from "node:fs";
import path from "node:path";
import type { ConversationSession } from "./types.js";

const MAX_MESSAGES_PER_SESSION = 100;
const PERSIST_MESSAGES = 30; // Persist last N messages to disk

export class SessionStore {
  private sessions = new Map<string, ConversationSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private persistDir: string | null = null;

  constructor(private ttlMs: number) {
    this.cleanupTimer = setInterval(() => this.evictStale(), 5 * 60 * 1000);
  }

  /** Enable disk persistence for sessions. */
  enablePersistence(dir: string): void {
    this.persistDir = dir;
    fs.mkdirSync(dir, { recursive: true });
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
      // Try restoring from disk first
      session = this.restoreFromDisk(key) ?? undefined;
      if (!session) {
        session = {
          key,
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
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
    this.persistToDisk(session);
  }

  /** Persist last N messages to disk (called after agent reply). */
  persistSession(key: string): void {
    const session = this.sessions.get(key);
    if (session) this.persistToDisk(session);
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.updatedAt > this.ttlMs) {
        this.sessions.delete(key);
        this.deleteFromDisk(key);
      }
    }
  }

  // ─── Disk persistence ─────────────────────────────────────────────

  private sessionFilePath(key: string): string | null {
    if (!this.persistDir) return null;
    // Sanitize key for filesystem: replace colons and slashes
    const safe = key.replace(/[/:]/g, "_");
    return path.join(this.persistDir, `${safe}.json`);
  }

  private persistToDisk(session: ConversationSession): void {
    const filePath = this.sessionFilePath(session.key);
    if (!filePath) return;
    try {
      const toSave = {
        key: session.key,
        messages: session.messages.slice(-PERSIST_MESSAGES),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
      const tmp = filePath + `.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(toSave), "utf-8");
      fs.renameSync(tmp, filePath);
    } catch {
      // Best-effort
    }
  }

  private restoreFromDisk(key: string): ConversationSession | null {
    const filePath = this.sessionFilePath(key);
    if (!filePath) return null;
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as ConversationSession;
      if (data.key === key && Array.isArray(data.messages)) {
        console.log(`[session] Restored ${data.messages.length} messages from disk for ${key}`);
        return data;
      }
    } catch {
      // Corrupted file — ignore
    }
    return null;
  }

  private deleteFromDisk(key: string): void {
    const filePath = this.sessionFilePath(key);
    if (!filePath) return;
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
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
