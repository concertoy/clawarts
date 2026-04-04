import crypto from "node:crypto";
import { loadStore, saveStore } from "./json-store.js";
import type { Submission } from "./types.js";

export class SubmissionStore {
  constructor(private readonly storePath: string) {}

  private async load() {
    return loadStore<Submission>(this.storePath);
  }

  private async save(items: Submission[]) {
    await saveStore(this.storePath, { version: 1, items });
  }

  async submit(
    data: Omit<Submission, "id" | "submittedAt" | "status">,
    deadline: number,
  ): Promise<Submission> {
    const store = await this.load();

    // Overwrite previous submission from same user for same assignment
    const existingIdx = store.items.findIndex(
      (s) => s.assignmentId === data.assignmentId && s.userId === data.userId,
    );

    const submission: Submission = {
      ...data,
      id: crypto.randomUUID(),
      submittedAt: Date.now(),
      status: Date.now() > deadline ? "late" : "submitted",
    };

    if (existingIdx !== -1) {
      store.items[existingIdx] = submission;
    } else {
      store.items.push(submission);
    }

    await this.save(store.items);
    return submission;
  }

  async listByAssignment(assignmentId: string): Promise<Submission[]> {
    const store = await this.load();
    return store.items.filter((s) => s.assignmentId === assignmentId);
  }

  async listByUser(userId: string): Promise<Submission[]> {
    const store = await this.load();
    return store.items.filter((s) => s.userId === userId);
  }

  async getByAssignmentAndUser(assignmentId: string, userId: string): Promise<Submission | undefined> {
    const store = await this.load();
    return store.items.find((s) => s.assignmentId === assignmentId && s.userId === userId);
  }

  /** Count submissions per assignment (avoids loading full content for reporting). */
  async countByAssignment(assignmentId: string): Promise<{ total: number; late: number }> {
    const store = await this.load();
    const subs = store.items.filter((s) => s.assignmentId === assignmentId);
    return {
      total: subs.length,
      late: subs.filter((s) => s.status === "late").length,
    };
  }
}
