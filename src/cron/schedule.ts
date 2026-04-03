import type { CronSchedule } from "./types.js";

/**
 * Compute the next run time for a schedule.
 * Ported from openclaw src/cron/schedule.ts (at + every branches).
 */
export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind === "at") {
    return schedule.atMs > nowMs ? schedule.atMs : undefined;
  }

  // kind === "every"
  const everyMs = Math.max(1, Math.floor(schedule.everyMs));
  const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));

  if (nowMs < anchor) {
    return anchor;
  }

  const elapsed = nowMs - anchor;
  const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
  return anchor + steps * everyMs;
}
