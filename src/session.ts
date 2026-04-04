import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ConversationSession } from "./types.js";

const MAX_MESSAGES_PER_SESSION = 100;
const PERSIST_MESSAGES = 30; // Persist last N messages to disk
const MAX_SESSIONS = 500; // LRU eviction threshold — prevents OOM under heavy load

export class SessionStore {
  private sessions = new Map<string, ConversationSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private persistDir: string | null = null;

  constructor(private ttlMs: number) {
    this.cleanupTimer = setInterval(() => {
      try { this.evictStale(); } catch (err) { console.error("[session] Cleanup error:", err); }
    }, 5 * 60 * 1000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
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
    // LRU eviction: if we've hit the limit, evict the oldest session
    if (this.sessions.size > MAX_SESSIONS) {
      this.evictOldest();
    }
    return session;
  }

  /** Evict the oldest session by updatedAt to stay under MAX_SESSIONS. */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, session] of this.sessions) {
      if (session.updatedAt < oldestTime) {
        oldestTime = session.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const evicted = this.sessions.get(oldestKey);
      if (evicted) this.persistToDisk(evicted);
      this.sessions.delete(oldestKey);
    }
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
    // Sanitize key for filesystem: replace colons and slashes.
    // Hash long keys to avoid exceeding filesystem path limits.
    let safe = key.replace(/[/:]/g, "_");
    if (safe.length > 100) {
      safe = createHash("sha256").update(key).digest("hex").slice(0, 32);
    }
    return path.join(this.persistDir, `${safe}.json`);
  }

  private persistToDisk(session: ConversationSession): void {
    const filePath = this.sessionFilePath(session.key);
    if (!filePath) return;
    const tmp = filePath + `.tmp.${process.pid}`;
    try {
      const toSave = {
        key: session.key,
        messages: session.messages.slice(-PERSIST_MESSAGES),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
      fs.writeFileSync(tmp, JSON.stringify(toSave), "utf-8");
      fs.renameSync(tmp, filePath);
    } catch (err) {
      // Clean up orphan temp file on failure
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      console.warn(`[session] Failed to persist ${session.key}:`, err instanceof Error ? err.message : err);
    }
  }

  private restoreFromDisk(key: string): ConversationSession | null {
    const filePath = this.sessionFilePath(key);
    if (!filePath) return null;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as ConversationSession;
      if (data.key === key && Array.isArray(data.messages)) {
        // Validate message structure — filter out corrupted entries
        data.messages = data.messages.filter(
          (m) => m && typeof m.role === "string" && typeof m.content === "string",
        );
        console.log(`[session] Restored ${data.messages.length} messages from disk for ${key}`);
        return data;
      }
    } catch (err) {
      // ENOENT = no persisted session (normal); anything else = corrupted file
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[session] Corrupted session file for ${key}:`, err instanceof Error ? err.message : err);
      }
    }
    return null;
  }

  private deleteFromDisk(key: string): void {
    const filePath = this.sessionFilePath(key);
    if (!filePath) return;
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }

  /** Persist all in-memory sessions to disk before shutdown. */
  persistAll(): void {
    for (const session of this.sessions.values()) {
      this.persistToDisk(session);
    }
  }

  destroy(): void {
    this.persistAll();
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
