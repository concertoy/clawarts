import crypto from "node:crypto";
import { loadStore, saveStore, withStoreLock } from "./json-store.js";
import type { Assignment } from "./types.js";

export class AssignmentStore {
  constructor(private readonly storePath: string) {}

  private async load() {
    return loadStore<Assignment>(this.storePath);
  }

  private async save(items: Assignment[]) {
    await saveStore(this.storePath, { version: 1, items });
  }

  async create(data: Omit<Assignment, "id" | "createdAt">): Promise<Assignment> {
    return withStoreLock(this.storePath, async () => {
      const store = await this.load();
      const assignment: Assignment = {
        ...data,
        id: crypto.randomUUID(),
        createdAt: Date.now(),
      };
      store.items.push(assignment);
      await this.save(store.items);
      return assignment;
    });
  }

  async list(filter?: { status?: Assignment["status"] }): Promise<Assignment[]> {
    const store = await this.load();
    if (filter?.status) {
      return store.items.filter((a) => a.status === filter.status);
    }
    return store.items;
  }

  async get(id: string): Promise<Assignment | undefined> {
    const store = await this.load();
    return store.items.find((a) => a.id === id);
  }

  async update(id: string, patch: Partial<Assignment>): Promise<Assignment | undefined> {
    return withStoreLock(this.storePath, async () => {
      const store = await this.load();
      const idx = store.items.findIndex((a) => a.id === id);
      if (idx === -1) return undefined;
      const updated = { ...store.items[idx], ...patch };
      store.items[idx] = updated;
      await this.save(store.items);
      return updated;
    });
  }

  async close(id: string): Promise<Assignment | undefined> {
    return this.update(id, { status: "closed" });
  }

  /** List all assignments (no filter). Useful for reporting/export. */
  async listAll(): Promise<Assignment[]> {
    const store = await this.load();
    return store.items;
  }

  /** Count assignments by status. */
  async countByStatus(): Promise<{ open: number; closed: number; total: number }> {
    const store = await this.load();
    const open = store.items.filter((a) => a.status === "open").length;
    return { open, closed: store.items.length - open, total: store.items.length };
  }

  /** Auto-close assignments whose deadline has passed. Returns count of closed. */
  async closeExpired(): Promise<number> {
    return withStoreLock(this.storePath, async () => {
      const store = await this.load();
      const now = Date.now();
      let closed = 0;
      for (const a of store.items) {
        if (a.status === "open" && a.deadline < now) {
          a.status = "closed";
          closed++;
        }
      }
      if (closed > 0) await this.save(store.items);
      return closed;
    });
  }
}
