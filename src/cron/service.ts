import { randomUUID } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import type { CronJob, CronJobCreate, CronJobPatch, CronStoreFile } from "./types.js";
import { computeNextRunAtMs } from "./schedule.js";
import { loadCronStore, saveCronStore } from "./store.js";

const MAX_TIMER_DELAY_MS = 60_000;
const MIN_REFIRE_GAP_MS = 2_000;

/**
 * Simplified cron scheduler service.
 * Ported from openclaw src/cron/service.ts + service/timer.ts.
 *
 * Timer loop: single setTimeout, re-armed after each tick.
 * Execution: sends Slack messages directly via WebClient.
 */
export class CronService {
  private store: CronStoreFile | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private opts: {
      agentId: string;
      storePath: string;
      slackClient: WebClient;
      nowMs?: () => number;
    },
  ) {}

  private now(): number {
    return this.opts.nowMs ? this.opts.nowMs() : Date.now();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.store = await loadCronStore(this.opts.storePath);
    this.recomputeNextRuns();
    await this.persist();
    this.armTimer();
    const enabled = this.store.jobs.filter((j) => j.enabled).length;
    if (enabled > 0) {
      console.log(`[cron:${this.opts.agentId}] Started with ${enabled} active job(s)`);
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────

  async add(input: CronJobCreate): Promise<CronJob> {
    await this.ensureLoaded();
    const now = this.now();

    const job: CronJob = {
      ...input,
      id: randomUUID(),
      createdAtMs: now,
      state: {
        nextRunAtMs: computeNextRunAtMs(input.schedule, now),
      },
    };

    this.store!.jobs.push(job);
    await this.persist();
    this.armTimer();
    console.log(`[cron:${this.opts.agentId}] Added job "${job.name}" (${job.id}), next: ${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : "never"}`);
    return job;
  }

  async update(id: string, patch: CronJobPatch): Promise<CronJob | null> {
    await this.ensureLoaded();
    const job = this.store!.jobs.find((j) => j.id === id);
    if (!job) return null;

    if (patch.name !== undefined) job.name = patch.name;
    if (patch.message !== undefined) job.message = patch.message;
    if (patch.enabled !== undefined) job.enabled = patch.enabled;
    if (patch.schedule !== undefined) {
      job.schedule = patch.schedule;
      job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, this.now());
    }

    await this.persist();
    this.armTimer();
    return job;
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const before = this.store!.jobs.length;
    this.store!.jobs = this.store!.jobs.filter((j) => j.id !== id);
    if (this.store!.jobs.length === before) return false;
    await this.persist();
    this.armTimer();
    return true;
  }

  async list(): Promise<CronJob[]> {
    await this.ensureLoaded();
    return this.store!.jobs
      .filter((j) => j.enabled)
      .sort((a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity));
  }

  async listAll(): Promise<CronJob[]> {
    await this.ensureLoaded();
    return [...this.store!.jobs];
  }

  getJob(id: string): CronJob | undefined {
    return this.store?.jobs.find((j) => j.id === id);
  }

  // ─── Timer ────────────────────────────────────────────────────────────

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.store) return;

    const now = this.now();
    const enabledJobs = this.store.jobs.filter((j) => j.enabled && j.state.nextRunAtMs != null);
    if (enabledJobs.length === 0) return;

    const nextWake = Math.min(...enabledJobs.map((j) => j.state.nextRunAtMs!));
    let delay = Math.max(0, nextWake - now);

    // Clamp: never sleep longer than MAX_TIMER_DELAY_MS (periodic wakeup)
    delay = Math.min(delay, MAX_TIMER_DELAY_MS);
    // Floor: prevent tight loops
    delay = Math.max(delay, MIN_REFIRE_GAP_MS);

    this.timer = setTimeout(() => void this.onTimer(), delay);
  }

  private async onTimer(): Promise<void> {
    if (this.running) {
      // Re-arm and skip if already executing
      this.armTimer();
      return;
    }

    this.running = true;
    try {
      await this.ensureLoaded();
      const now = this.now();

      // Collect due jobs
      const dueJobs = this.store!.jobs.filter(
        (j) => j.enabled && j.state.nextRunAtMs != null && j.state.nextRunAtMs <= now,
      );

      for (const job of dueJobs) {
        await this.executeJob(job, now);
      }

      if (dueJobs.length > 0) {
        await this.persist();
      }
    } catch (err) {
      console.error(`[cron:${this.opts.agentId}] Timer error:`, err);
    } finally {
      this.running = false;
      this.armTimer();
    }
  }

  private async executeJob(job: CronJob, nowMs: number): Promise<void> {
    try {
      await this.opts.slackClient.chat.postMessage({
        channel: job.channelId,
        text: `\u{1f514} *${job.name}*\n${job.message}`,
      });

      job.state.lastRunAtMs = nowMs;
      job.state.lastStatus = "ok";
      job.state.lastError = undefined;

      // Advance schedule
      if (job.schedule.kind === "at") {
        // One-shot: disable after firing
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
      } else {
        // Recurring: compute next run
        job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, nowMs);
      }

      console.log(`[cron:${this.opts.agentId}] Fired "${job.name}" → ${job.channelId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.state.lastRunAtMs = nowMs;
      job.state.lastStatus = "error";
      job.state.lastError = msg;

      // Still advance schedule so we don't get stuck
      if (job.schedule.kind === "every") {
        job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, nowMs);
      } else {
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
      }

      console.error(`[cron:${this.opts.agentId}] Job "${job.name}" failed:`, msg);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (!this.store) {
      this.store = await loadCronStore(this.opts.storePath);
    }
  }

  private recomputeNextRuns(): void {
    if (!this.store) return;
    const now = this.now();
    for (const job of this.store.jobs) {
      if (!job.enabled) continue;
      job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, now);
    }
  }

  private async persist(): Promise<void> {
    if (!this.store) return;
    await saveCronStore(this.opts.storePath, this.store);
  }
}
