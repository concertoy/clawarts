/** Schedule types — simplified from openclaw's CronSchedule (at/every only). */
export type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number };

export interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
  /** Number of consecutive delivery failures (for retry logic). */
  retryCount?: number;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: CronSchedule;
  message: string;
  channelId: string;
  agentId: string;
  enabled: boolean;
  createdAtMs: number;
  state: CronJobState;
}

export interface CronStoreFile {
  version: 1;
  jobs: CronJob[];
}

export type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "state">;

export type CronJobPatch = Partial<Pick<CronJob, "name" | "message" | "schedule" | "enabled">>;
