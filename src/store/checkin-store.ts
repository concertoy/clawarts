import crypto from "node:crypto";
import path from "node:path";
import { loadStore, saveStore } from "./json-store.js";
import type { CheckinWindow, CheckinResponse } from "./types.js";

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
  private windowsPath: string;
  private responsesPath: string;

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
    // Auto-close any expired windows first (in case cron job was late)
    await this.closeExpiredWindows();
    const store = await loadStore<CheckinWindow>(this.windowsPath);
    const now = Date.now();
    return store.items.find((w) => w.status === "open" && w.closesAt != null && w.closesAt > now);
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

  /** Close any open windows whose closesAt has passed. */
  async closeExpiredWindows(): Promise<number> {
    const store = await loadStore<CheckinWindow>(this.windowsPath);
    const now = Date.now();
    let closed = 0;
    for (const w of store.items) {
      if (w.status === "open" && w.closesAt != null && w.closesAt <= now) {
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
    // Validate window
    const window = await this.getWindow(data.windowId);
    if (!window) return { error: "Check-in window not found." };
    if (window.status !== "open") return { error: "Check-in window is closed." };
    if (Date.now() > window.closesAt) return { error: "Check-in window has expired." };

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
    };

    if (existingIdx !== -1) {
      store.items[existingIdx] = response;
    } else {
      store.items.push(response);
    }

    await saveStore(this.responsesPath, store);
    return response;
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

  // ─── Evaluation (tutor only) ─────────────────────────────────────

  async evaluateResponse(
    responseId: string,
    patch: { score: number; status: CheckinResponse["status"]; feedback?: string },
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
    evaluations: { responseId: string; score: number; status: CheckinResponse["status"]; feedback?: string }[],
  ): Promise<number> {
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
  }
}
