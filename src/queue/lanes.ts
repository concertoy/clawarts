/**
 * Command lanes for parallel execution.
 * Ported from OpenClaw's process/lanes.ts (simplified to 2 lanes).
 */
export const CommandLane = {
  /** User messages from Slack. */
  Main: "main",
  /** Cron/scheduled job delivery. */
  Cron: "cron",
} as const;

export type CommandLaneType = (typeof CommandLane)[keyof typeof CommandLane];
