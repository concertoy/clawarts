/**
 * Multi-lane command queue with per-lane concurrency control.
 * Ported from OpenClaw's process/command-queue.ts (simplified).
 *
 * Each lane has its own task queue and max concurrency setting.
 * Tasks within a lane respect concurrency limits; different lanes
 * execute independently and don't block each other.
 */
import { CommandLane, type CommandLaneType } from "./lanes.js";

// ─── Types ───────────────────────────────────────────────────────────

interface QueueEntry {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
}

interface LaneState {
  lane: string;
  queue: QueueEntry[];
  activeCount: number;
  maxConcurrent: number;
  draining: boolean;
}

// ─── State ───────────────────────────────────────────────────────────

const STALE_TASK_MS = 5 * 60 * 1000; // 5 minutes — tasks queued longer are evicted

const lanes = new Map<string, LaneState>();

function getLaneState(lane: string): LaneState {
  let state = lanes.get(lane);
  if (!state) {
    state = {
      lane,
      queue: [],
      activeCount: 0,
      maxConcurrent: 1,
      draining: false,
    };
    lanes.set(lane, state);
  }
  return state;
}

// ─── Drain pump ──────────────────────────────────────────────────────

function drainLane(lane: string): void {
  const state = getLaneState(lane);
  if (state.draining) return;
  state.draining = true;

  void (async () => {
    try {
      while (state.queue.length > 0 && state.activeCount < state.maxConcurrent) {
        const entry = state.queue.shift();
        if (!entry) break;
        // Evict stale tasks — prevents pileup when the bot is slow
        if (Date.now() - entry.enqueuedAt > STALE_TASK_MS) {
          console.warn(`[command-queue] Evicting stale task in lane "${lane}" (queued ${Math.round((Date.now() - entry.enqueuedAt) / 1000)}s ago)`);
          entry.reject(new Error(`Task evicted: queued for ${Math.round((Date.now() - entry.enqueuedAt) / 1000)}s (limit: ${STALE_TASK_MS / 1000}s)`));
          continue;
        }
        state.activeCount++;

        // Fire-and-forget: task runs concurrently, pump continues
        void (async () => {
          try {
            const result = await entry.task();
            entry.resolve(result);
          } catch (err) {
            entry.reject(err);
          } finally {
            state.activeCount--;
            // Re-trigger pump to process next queued item
            drainLane(lane);
          }
        })();
      }
    } finally {
      state.draining = false;
    }
  })();
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Enqueue a task into a specific lane.
 * Returns a promise that resolves when the task completes.
 */
export function enqueueCommand<T>(
  lane: CommandLaneType | string,
  task: () => Promise<T>,
): Promise<T> {
  const state = getLaneState(lane);

  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task: task as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
      enqueuedAt: Date.now(),
    });
    drainLane(lane);
  });
}

/**
 * Set the max concurrency for a lane.
 */
export function setLaneConcurrency(lane: CommandLaneType | string, maxConcurrent: number): void {
  const state = getLaneState(lane);
  state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  drainLane(lane);
}

/**
 * Clear all pending tasks in a lane. Active tasks continue to completion.
 */
export function clearLane(lane: CommandLaneType | string): number {
  const state = getLaneState(lane);
  const removed = state.queue.length;
  for (const entry of state.queue.splice(0)) {
    entry.reject(new Error(`Lane "${lane}" cleared`));
  }
  return removed;
}

/**
 * Get the number of active + queued tasks in a lane.
 */
export function getLaneDepth(lane: CommandLaneType | string): number {
  const state = getLaneState(lane);
  return state.activeCount + state.queue.length;
}

// Set default concurrencies
setLaneConcurrency(CommandLane.Main, 4);  // Up to 4 concurrent user messages
setLaneConcurrency(CommandLane.Cron, 1);  // Cron jobs serialized by default
