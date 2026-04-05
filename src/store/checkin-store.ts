import crypto from "node:crypto";
import path from "node:path";
import { loadStore, saveStore, withStoreLock } from "./json-store.js";
import type { CheckinWindow, CheckinResponse, CheckinStatus } from "./types.js";

/** Check if a window is currently active (open and not expired). */
function isWindowActive(w: CheckinWindow, now: number): boolean {
  return w.status === "open" && w.closesAt != null && w.closesAt > now;
}

/**
 * Check-in store. All data lives in the tutor's data directory.
 * Windows and responses are stored in separate files for clean separation.
 *
 * Security model:
 * - Student tools can only call addResponse() and read methods
 * - Tutor tools can create/close windows and evaluate responses
 * - Score, status, feedback fields are only written by evaluateResponse/bulkEvaluate
 */
export class CheckinStore {
  private readonly windowsPath: string;
  private readonly responsesPath: string;

  constructor(dataDir: string) {
    this.windowsPath = path.join(dataDir, "checkin-windows.json");
    this.responsesPath = path.join(dataDir, "checkin-responses.json");
  }

  // ─── Window management (tutor only) ──────────────────────────────

  async createWindow(data: Omit<CheckinWindow, "id" | "openedAt" | "status">): Promise<CheckinWindow> {
    const store = await loadStore<CheckinWindow>(this.windowsPath);
    const window: CheckinWindow = {
      ...data,
      id: crypto.randomUUID(),
      openedAt: Date.now(),
      status: "open",
    };
    store.items.push(window);
    await saveStore(this.windowsPath, store);
    return window;
  }

  async getWindow(id: string): Promise<CheckinWindow | undefined> {
    const store = await loadStore<CheckinWindow>(this.windowsPath);
    return store.items.find((w) => w.id === id);
  }

  async getActiveWindow(): Promise<CheckinWindow | undefined> {
    // Auto-close expired then find active — single load
    const store = await loadStore<CheckinWindow>(this.windowsPath);
    const now = Date.now();
    let dirty = false;
    for (const w of store.items) {
      if (w.status === "open" && !isWindowActive(w, now)) {
        w.status = "closed";
        dirty = true;
      }
    }
    if (dirty) await saveStore(this.windowsPath, store);
    return store.items.find((w) => isWindowActive(w, now));
  }

  /** Get the most recent window that's still within the grace period (active or just expired). */
  async getRespondableWindow(): Promise<CheckinWindow | undefined> {
    const GRACE_PERIOD_MS = 60_000;
    const store = await loadStore<CheckinWindow>(this.windowsPath);
    const now = Date.now();
    // First try active windows
    const active = store.items.find((w) => isWindowActive(w, now));
    if (active) return active;
    // Then try recently-expired windows still within grace period
    return store.items
      .filter((w) => w.status === "open" && w.closesAt < now && now - w.closesAt < GRACE_PERIOD_MS)
      .sort((a, b) => b.closesAt - a.closesAt)[0];
  }

  async closeWindow(id: string): Promise<CheckinWindow | undefined> {
    const store = await loadStore<CheckinWindow>(this.windowsPath);
    const idx = store.items.findIndex((w) => w.id === id);
    if (idx === -1) return undefined;
    store.items[idx].status = "closed";
    await saveStore(this.windowsPath, store);
    return store.items[idx];
  }

  async listWindows(filter?: { pulseGroupId?: string }): Promise<CheckinWindow[]> {
    const store = await loadStore<CheckinWindow>(this.windowsPath);
    if (filter?.pulseGroupId) {
      return store.items.filter((w) => w.pulseGroupId === filter.pulseGroupId);
    }
    return store.items;
  }

  /** List currently active (open and not expired) windows. */
  async listActiveWindows(): Promise<CheckinWindow[]> {
    const store = await loadStore<CheckinWindow>(this.windowsPath);
    const now = Date.now();
    return store.items.filter((w) => isWindowActive(w, now));
  }

  /** Close any open windows whose closesAt has passed. */
  async closeExpiredWindows(): Promise<number> {
    const store = await loadStore<CheckinWindow>(this.windowsPath);
    const now = Date.now();
    let closed = 0;
    for (const w of store.items) {
      if (w.status === "open" && !isWindowActive(w, now)) {
        w.status = "closed";
        closed++;
      }
    }
    if (closed > 0) await saveStore(this.windowsPath, store);
    return closed;
  }

  // ─── Response management ─────────────────────────────────────────

  async addResponse(data: {
    windowId: string;
    userId: string;
    agentId: string;
    content: string;
  }): Promise<CheckinResponse | { error: string }> {
    const GRACE_PERIOD_MS = 60_000; // 60s grace period — responses accepted but marked late

    // Lock the responses file to prevent concurrent read-modify-write races
    // (multiple students may submit simultaneously during a check-in window).
    // Window validation is inside the lock to prevent TOCTOU: window could close
    // between an outside check and the lock acquisition.
    return withStoreLock(this.responsesPath, async () => {
      const window = await this.getWindow(data.windowId);
      if (!window) return { error: "Check-in window not found." };
      const now = Date.now();
      const isLate = now > window.closesAt;
      const pastGrace = now > window.closesAt + GRACE_PERIOD_MS;
      if (window.status !== "open" && !isLate) return { error: "Check-in window is closed." };
      if (pastGrace) return { error: "Check-in window has expired (grace period ended)." };

      const store = await loadStore<CheckinResponse>(this.responsesPath);

      // Overwrite previous response from same user for same window
      const existingIdx = store.items.findIndex(
        (r) => r.windowId === data.windowId && r.userId === data.userId,
      );

      const response: CheckinResponse = {
        id: crypto.randomUUID(),
        windowId: data.windowId,
        userId: data.userId,
        agentId: data.agentId,
        content: data.content,
        submittedAt: Date.now(), // server-set timestamp
        ...(isLate ? { status: "late" as CheckinStatus } : {}),
      };

      if (existingIdx !== -1) {
        store.items[existingIdx] = response;
      } else {
        store.items.push(response);
      }

      await saveStore(this.responsesPath, store);
      return response;
    });
  }

  async getResponse(id: string): Promise<CheckinResponse | undefined> {
    const store = await loadStore<CheckinResponse>(this.responsesPath);
    return store.items.find((r) => r.id === id);
  }

  /** Get a single response by window + user (avoids loading all responses). */
  async getResponseByWindowAndUser(windowId: string, userId: string): Promise<CheckinResponse | undefined> {
    const store = await loadStore<CheckinResponse>(this.responsesPath);
    return store.items.find((r) => r.windowId === windowId && r.userId === userId);
  }

  async getResponsesByWindow(windowId: string): Promise<CheckinResponse[]> {
    const store = await loadStore<CheckinResponse>(this.responsesPath);
    return store.items.filter((r) => r.windowId === windowId);
  }

  async getResponsesByUser(userId: string): Promise<CheckinResponse[]> {
    const store = await loadStore<CheckinResponse>(this.responsesPath);
    return store.items.filter((r) => r.userId === userId);
  }

  /** Count responses per window (avoids loading full content for reporting). */
  async countByWindow(windowId: string): Promise<{ total: number; evaluated: number }> {
    const store = await loadStore<CheckinResponse>(this.responsesPath);
    const responses = store.items.filter((r) => r.windowId === windowId);
    return {
      total: responses.length,
      evaluated: responses.filter((r) => r.evaluatedAt != null).length,
    };
  }

  /** Count total windows and responses for a user across all check-ins. */
  async countByUser(userId: string): Promise<{ responded: number; avgScore: number | null }> {
    const store = await loadStore<CheckinResponse>(this.responsesPath);
    const responses = store.items.filter((r) => r.userId === userId);
    const scored = responses.filter((r) => r.score != null);
    return {
      responded: responses.length,
      avgScore: scored.length > 0 ? scored.reduce((sum, r) => sum + r.score!, 0) / scored.length : null,
    };
  }

  // ─── Evaluation (tutor only) ─────────────────────────────────────

  async evaluateResponse(
    responseId: string,
    patch: { score: number; status: CheckinStatus; feedback?: string },
  ): Promise<CheckinResponse | undefined> {
    const store = await loadStore<CheckinResponse>(this.responsesPath);
    const idx = store.items.findIndex((r) => r.id === responseId);
    if (idx === -1) return undefined;
    store.items[idx] = {
      ...store.items[idx],
      ...patch,
      evaluatedAt: Date.now(),
    };
    await saveStore(this.responsesPath, store);
    return store.items[idx];
  }

  async bulkEvaluate(
    evaluations: { responseId: string; score: number; status: CheckinStatus; feedback?: string }[],
  ): Promise<number> {
    return withStoreLock(this.responsesPath, async () => {
      const store = await loadStore<CheckinResponse>(this.responsesPath);
      let updated = 0;
      for (const ev of evaluations) {
        const idx = store.items.findIndex((r) => r.id === ev.responseId);
        if (idx !== -1) {
          store.items[idx] = {
            ...store.items[idx],
            score: ev.score,
            status: ev.status,
            feedback: ev.feedback,
            evaluatedAt: Date.now(),
          };
          updated++;
        }
      }
      if (updated > 0) await saveStore(this.responsesPath, store);
      return updated;
    });
  }
}
