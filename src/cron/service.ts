import { randomUUID } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { errMsg } from "../utils/errors.js";
import type { CronJob, CronJobCreate, CronJobPatch, CronStoreFile } from "./types.js";
import { computeNextRunAtMs } from "./schedule.js";
import { loadCronStore, saveCronStore } from "./store.js";

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

  private systemHandler?: (tag: string, params: Record<string, string>, job: CronJob) => Promise<boolean>;

  constructor(
    private opts: {
      agentId: string;
      storePath: string;
      slackClient: WebClient;
      nowMs?: () => number;
    },
  ) {}

  /** Register a handler for [SYSTEM:*] cron messages. Return true to suppress Slack delivery. */
  setSystemMessageHandler(handler: (tag: string, params: Record<string, string>, job: CronJob) => Promise<boolean>): void {
    this.systemHandler = handler;
  }

  private now(): number {
    return this.opts.nowMs ? this.opts.nowMs() : Date.now();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.store = await loadCronStore(this.opts.storePath);
    this.recomputeNextRuns();
    await this.persist();
    this.armTimer();
    const enabled = this.store.jobs.filter((j) => j.enabled);
    if (enabled.length > 0) {
      const nextMs = Math.min(...enabled.map((j) => j.state.nextRunAtMs ?? Infinity));
      const nextStr = nextMs < Infinity ? new Date(nextMs).toISOString() : "none";
      console.log(`[cron:${this.opts.agentId}] Started with ${enabled.length} active job(s), next fire: ${nextStr}`);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Persist current state to disk so schedule advances aren't lost
    await this.persist();
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
    // Precise wakeup — no clamping. Node.js setTimeout handles large delays fine.
    const delay = Math.max(MIN_REFIRE_GAP_MS, nextWake - now);

    this.timer = setTimeout(() => void this.onTimer(), delay);
    if (this.timer.unref) this.timer.unref();
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
        // Advance schedule and persist BEFORE execution to prevent
        // double-firing if the process crashes mid-delivery.
        this.advanceSchedule(job, now);
      }
      if (dueJobs.length > 0) {
        await this.persist();
      }

      for (const job of dueJobs) {
        await this.deliverJob(job);
      }
      // Persist delivery status (lastStatus, lastError) to disk
      if (dueJobs.length > 0) await this.persist();
    } catch (err) {
      console.error(`[cron:${this.opts.agentId}] Timer error:`, errMsg(err));
    } finally {
      this.running = false;
      this.armTimer();
    }
  }

  /** Advance a job's schedule state (called BEFORE delivery to prevent double-fire on crash). */
  private advanceSchedule(job: CronJob, nowMs: number): void {
    job.state.lastRunAtMs = nowMs;
    if (job.schedule.kind === "at") {
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
    } else {
      job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, nowMs);
    }
  }

  /** Deliver a job's message to Slack. Schedule is already advanced. */
  private async deliverJob(job: CronJob): Promise<void> {
    try {
      // Intercept [SYSTEM:*] messages — handle silently without posting to Slack
      const sysMatch = job.message.match(/^\[SYSTEM:(\w+)\]\s*(.*)/);
      if (sysMatch && this.systemHandler) {
        const tag = sysMatch[1];
        const rest = sysMatch[2];
        const params: Record<string, string> = {};
        for (const m of rest.matchAll(/(\w+)=(\S+)/g)) params[m[1]] = m[2];
        const handled = await this.systemHandler(tag, params, job);
        if (handled) {
          job.state.lastStatus = "ok";
          console.log(`[cron:${this.opts.agentId}] System action "${tag}" handled for "${job.name}"`);
          return;
        }
      }

      await this.opts.slackClient.chat.postMessage({
        channel: job.channelId,
        text: `\u{1f514} *${job.name}*\n${job.message}`,
      });
      job.state.lastStatus = "ok";
      job.state.lastError = undefined;
      console.log(`[cron:${this.opts.agentId}] Fired "${job.name}" → ${job.channelId}`);
    } catch (err) {
      const msg = errMsg(err);
      job.state.lastStatus = "error";
      job.state.lastError = msg;
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
