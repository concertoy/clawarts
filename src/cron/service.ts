import { randomUUID } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { errMsg } from "../utils/errors.js";
import { createLogger } from "../utils/logger.js";
import type { CronJob, CronJobCreate, CronJobPatch, CronStoreFile } from "./types.js";
import { computeNextRunAtMs } from "./schedule.js";
import { loadCronStore, saveCronStore } from "./store.js";

const MIN_REFIRE_GAP_MS = 2_000;
const RETRY_DELAY_MS = 10_000; // Retry failed deliveries after 10s
const MAX_RETRIES = 1; // Single retry — don't spam on persistent failures
const STALE_JOB_AGE_MS = 24 * 60 * 60 * 1000; // Remove executed one-shot jobs after 24h
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Run stale cleanup at most once per hour
const PERSIST_TIMEOUT_MS = 5_000; // Max time for a persist() call before giving up

/**
 * Simplified cron scheduler service.
 * Ported from openclaw src/cron/service.ts + service/timer.ts.
 *
 * Timer loop: single setTimeout, re-armed after each tick.
 * Execution: sends Slack messages directly via WebClient.
 */
export class CronService {
  private readonly log;
  private store: CronStoreFile | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private running = false;
  private lastCleanupMs = 0;

  private systemHandler?: (tag: string, params: Record<string, string>, job: CronJob) => Promise<boolean>;

  constructor(
    private readonly opts: {
      agentId: string;
      storePath: string;
      slackClient: WebClient;
      nowMs?: () => number;
    },
  ) {
    this.log = createLogger(`cron:${opts.agentId}`);
  }

  /** Register a handler for [SYSTEM:*] cron messages. Return true to suppress Slack delivery. */
  setSystemMessageHandler(handler: (tag: string, params: Record<string, string>, job: CronJob) => Promise<boolean>): void {
    this.systemHandler = handler;
  }

  private now(): number {
    return this.opts.nowMs ? this.opts.nowMs() : Date.now();
  }

  /** Access jobs array. Only valid after ensureLoaded()/start(). */
  private get jobs(): CronJob[] {
    return this.store!.jobs;
  }
  private set jobs(value: CronJob[]) {
    this.store!.jobs = value;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.store = await loadCronStore(this.opts.storePath);
    this.cleanupStaleJobs();
    this.recomputeNextRuns();
    await this.persist();
    this.armTimer();
    const enabled = this.store.jobs.filter((j) => j.enabled);
    if (enabled.length > 0) {
      const nextMs = Math.min(...enabled.map((j) => j.state.nextRunAtMs ?? Infinity));
      const nextStr = nextMs < Infinity ? new Date(nextMs).toISOString() : "none";
      this.log.info(`Started with ${enabled.length} active job(s), next fire: ${nextStr}`);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Clear any pending retry timers to prevent fire-after-stop
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    // Persist current state to disk so schedule advances aren't lost
    await this.persist();
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────

  async add(input: CronJobCreate): Promise<CronJob> {
    await this.ensureLoaded();
    const now = this.now();

    // Idempotency: if an enabled job with the same name and channel already exists,
    // return it instead of creating a duplicate. Prevents double-creation from
    // skills that run twice (e.g., double-click on /new_homework).
    if (input.name) {
      const existing = this.jobs.find(
        (j) => j.name === input.name && j.enabled && j.channelId === input.channelId,
      );
      if (existing) {
        this.log.debug(`Idempotent skip: job "${input.name}" already exists (${existing.id})`);
        return existing;
      }
    }

    const job: CronJob = {
      ...input,
      id: randomUUID(),
      createdAtMs: now,
      state: {
        nextRunAtMs: computeNextRunAtMs(input.schedule, now),
      },
    };

    this.jobs.push(job);
    await this.persist();
    this.armTimer();
    this.log.info(`Added job "${job.name}" (${job.id}), next: ${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : "never"}`);
    return job;
  }

  async update(id: string, patch: CronJobPatch): Promise<CronJob | null> {
    await this.ensureLoaded();
    const job = this.jobs.find((j) => j.id === id);
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
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length === before) return false;
    await this.persist();
    this.armTimer();
    return true;
  }

  async list(): Promise<CronJob[]> {
    await this.ensureLoaded();
    return this.jobs
      .filter((j) => j.enabled)
      .sort((a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity));
  }

  async listAll(): Promise<CronJob[]> {
    await this.ensureLoaded();
    return [...this.jobs];
  }

  getJob(id: string): CronJob | undefined {
    return this.store?.jobs.find((j) => j.id === id);
  }

  /** Whether the cron service is loaded and has an active timer. */
  get isRunning(): boolean {
    return this.store !== null && this.timer !== null;
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

      // Periodic stale job cleanup (at most once per hour)
      if (now - this.lastCleanupMs >= CLEANUP_INTERVAL_MS) {
        this.cleanupStaleJobs();
        this.lastCleanupMs = now;
      }

      // Collect due jobs
      const dueJobs = this.jobs.filter(
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
      this.log.error(`Timer error:`, errMsg(err));
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
          this.log.info(`System action "${tag}" handled for "${job.name}"`);
          return;
        }
      }

      await this.opts.slackClient.chat.postMessage({
        channel: job.channelId,
        text: `\u{1f514} *${job.name}*\n${job.message}`,
      });
      job.state.lastStatus = "ok";
      job.state.lastError = undefined;
      job.state.retryCount = 0;
      this.log.info(`Fired "${job.name}" → ${job.channelId}`);
    } catch (err) {
      const msg = errMsg(err);
      job.state.lastStatus = "error";
      job.state.lastError = msg;
      const retryCount = job.state.retryCount ?? 0;
      if (retryCount < MAX_RETRIES) {
        job.state.retryCount = retryCount + 1;
        this.log.warn(`Job "${job.name}" failed (retry ${retryCount + 1}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s): ${msg}`);
        // Schedule a retry — tracked so stop() can cancel it
        const retryTimer = setTimeout(() => {
          this.retryTimers.delete(retryTimer);
          void this.retryJob(job);
        }, RETRY_DELAY_MS);
        if (retryTimer.unref) retryTimer.unref();
        this.retryTimers.add(retryTimer);
      } else {
        this.log.error(`Job "${job.name}" failed (no more retries): ${msg}; will retry at next scheduled run`);
      }
    }
  }

  /** Retry a failed job delivery. */
  private async retryJob(job: CronJob): Promise<void> {
    try {
      await this.deliverJob(job);
      if (job.state.lastStatus === "ok") {
        job.state.retryCount = 0;
        await this.persist();
      }
    } catch (err) {
      this.log.error(`Job "${job.name}" retry failed:`, errMsg(err));
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (!this.store) {
      this.store = await loadCronStore(this.opts.storePath);
    }
  }

  /** Remove disabled one-shot (at) jobs that fired more than 24h ago. */
  private cleanupStaleJobs(): void {
    if (!this.store) return;
    const now = this.now();
    const before = this.store.jobs.length;
    this.store.jobs = this.store.jobs.filter((j) => {
      if (j.schedule.kind !== "at") return true; // keep recurring jobs
      if (j.enabled) return true; // keep active jobs
      if (!j.state.lastRunAtMs) return true; // keep unexecuted jobs
      return now - j.state.lastRunAtMs < STALE_JOB_AGE_MS;
    });
    const removed = before - this.store.jobs.length;
    if (removed > 0) {
      this.log.info(`Cleaned up ${removed} stale one-shot job(s)`);
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
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("persist() timed out")), PERSIST_TIMEOUT_MS),
    );
    try {
      await Promise.race([saveCronStore(this.opts.storePath, this.store), timeout]);
    } catch (err) {
      this.log.error(`Failed to persist cron store: ${errMsg(err)}`);
    }
  }
}
