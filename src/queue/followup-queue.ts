/**
 * Followup queue for messages arriving while agent is busy on the same session.
 * Debounces and batches queued messages before draining them to the agent.
 * Ported from OpenClaw's auto-reply/reply/queue/ (simplified).
 */

import { errMsg } from "../utils/errors.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("followup-queue");

// ─── Types ───────────────────────────────────────────────────────────

export interface FollowupItem {
  text: string;
  userId: string;
  ts: string;
  enqueuedAt: number;
}

interface FollowupQueueState {
  items: FollowupItem[];
  draining: boolean;
  lastEnqueuedAt: number;
  debounceMs: number;
  cap: number;
  droppedCount: number;
}

type DrainCallback = (items: FollowupItem[]) => Promise<void>;

// ─── State ───────────────────────────────────────────────────────────

const queues = new Map<string, FollowupQueueState>();
const drainCallbacks = new Map<string, DrainCallback>();

const DEFAULT_DEBOUNCE_MS = 1500;
const DEFAULT_CAP = 20;
const MAX_ITEM_AGE_MS = 3 * 60 * 1000; // 3 minutes — stale followups are dropped

function getQueue(key: string): FollowupQueueState {
  let q = queues.get(key);
  if (!q) {
    q = {
      items: [],
      draining: false,
      lastEnqueuedAt: 0,
      debounceMs: DEFAULT_DEBOUNCE_MS,
      cap: DEFAULT_CAP,
      droppedCount: 0,
    };
    queues.set(key, q);
  }
  return q;
}

// ─── Enqueue ─────────────────────────────────────────────────────────

/**
 * Enqueue a followup message for a session that's currently busy.
 * Returns true if the message was queued, false if dropped (at capacity).
 */
export function enqueueFollowup(
  sessionKey: string,
  item: FollowupItem,
  onDrain?: DrainCallback,
): boolean {
  const q = getQueue(sessionKey);

  // Dedupe by timestamp (same message)
  if (q.items.some((i) => i.ts === item.ts)) {
    return false;
  }

  // Drop oldest if at capacity
  if (q.items.length >= q.cap) {
    q.items.shift();
    q.droppedCount++;
  }

  q.items.push(item);
  q.lastEnqueuedAt = Date.now();

  if (onDrain) {
    drainCallbacks.set(sessionKey, onDrain);
  }

  // Kick drain if idle
  if (!q.draining) {
    scheduleDrain(sessionKey);
  }

  return true;
}

// ─── Drain ───────────────────────────────────────────────────────────

function scheduleDrain(sessionKey: string): void {
  const q = queues.get(sessionKey);
  if (!q || q.draining || q.items.length === 0) return;
  q.draining = true;

  void (async () => {
    try {
      while (q.items.length > 0) {
        // Debounce: wait for more messages to accumulate
        await waitForDebounce(q);

        const callback = drainCallbacks.get(sessionKey);
        if (!callback) break; // Don't splice — items stay queued until a callback is registered

        // Evict stale items before batching
        const now = Date.now();
        const prevLen = q.items.length;
        q.items = q.items.filter((i) => now - i.enqueuedAt <= MAX_ITEM_AGE_MS);
        q.droppedCount += prevLen - q.items.length;

        // Collect all current items into a batch
        const batch = q.items.splice(0);
        if (batch.length === 0) break;

        // Prepend drop notice if messages were lost
        if (q.droppedCount > 0) {
          const notice: FollowupItem = {
            text: `[${q.droppedCount} earlier message(s) were dropped while agent was busy]`,
            userId: "system",
            ts: `system-${Date.now()}`,
            enqueuedAt: Date.now(),
          };
          batch.unshift(notice);
          q.droppedCount = 0;
        }

        try {
          await callback(batch);
        } catch (err) {
          log.warn(`Drain failed for ${sessionKey}:`, errMsg(err));
        }
      }
    } finally {
      q.draining = false;
      // Cleanup if empty
      if (q.items.length === 0 && q.droppedCount === 0) {
        queues.delete(sessionKey);
        drainCallbacks.delete(sessionKey);
      } else if (q.items.length > 0) {
        // More items arrived during drain — reschedule
        scheduleDrain(sessionKey);
      }
    }
  })();
}

async function waitForDebounce(q: FollowupQueueState): Promise<void> {
  while (true) {
    const elapsed = Date.now() - q.lastEnqueuedAt;
    if (elapsed >= q.debounceMs) return;
    await new Promise((r) => { const t = setTimeout(r, q.debounceMs - elapsed); if (t.unref) t.unref(); });
  }
}

// ─── Query ───────────────────────────────────────────────────────────

/**
 * Check if a session has pending followup messages.
 */
export function hasFollowups(sessionKey: string): boolean {
  const q = queues.get(sessionKey);
  return !!q && q.items.length > 0;
}

/**
 * Clear all followup messages for a session.
 */
export function clearFollowups(sessionKey: string): number {
  const q = queues.get(sessionKey);
  if (!q) return 0;
  const count = q.items.length;
  q.items.length = 0;
  q.droppedCount = 0;
  queues.delete(sessionKey);
  drainCallbacks.delete(sessionKey);
  return count;
}
