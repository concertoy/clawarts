import type { ToolDefinition, ToolUseContext } from "../types.js";
import type { CronService } from "./service.js";
import type { CronJobPatch, CronSchedule } from "./types.js";
import { formatDuration } from "../utils/format.js";

/**
 * Create a cron/reminder tool for the agent.
 * Ported from openclaw src/agents/tools/cron-tool.ts (simplified to 4 actions).
 */
export function createCronTool(cronService: CronService, agentId: string): ToolDefinition {
  return {
    name: "cron",
    description:
      "Schedule recurring reminders and one-shot alerts. Use this when the user asks to be reminded about something, or to schedule a recurring notification. Actions: add (create a job), list (show active jobs), remove (delete a job), update (modify a job).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "list", "remove", "update", "purge"],
          description: "The action to perform.",
        },
        // For add:
        name: { type: "string", description: "Short label for the reminder (e.g. 'Drink water')." },
        message: { type: "string", description: "The text to send when the reminder fires." },
        channelId: { type: "string", description: "Slack channel ID to deliver the reminder to. Use the channel from the current conversation." },
        scheduleKind: {
          type: "string",
          enum: ["at", "every"],
          description: '"at" for a one-shot reminder at a specific time, "every" for a recurring interval.',
        },
        atMs: { type: "number", description: "Epoch milliseconds for a one-shot reminder (scheduleKind=at). Compute from current date." },
        everyMs: { type: "number", description: "Interval in milliseconds for recurring reminders (scheduleKind=every). Examples: 3600000=1hr, 86400000=1day." },
        // For remove/update:
        jobId: { type: "string", description: "Job ID (for remove/update actions)." },
        // For update:
        enabled: { type: "boolean", description: "Enable or disable a job (for update action)." },
      },
      required: ["action"],
    },
    isReadOnly: false,
    category: "scheduling",

    async execute(input: Record<string, unknown>, context?: ToolUseContext): Promise<string> {
      const action = input.action as string;

      switch (action) {
        case "add": {
          const name = ((input.name as string) || "").trim() || "Reminder";
          const message = ((input.message as string) || "").trim() || name;
          // Auto-inject channelId from ToolUseContext if LLM didn't supply it
          const channelId = ((input.channelId as string) || "").trim() || context?.channelId || "";
          if (!channelId) return "Error: channelId is required to schedule a reminder.";
          if (!/^[CDG][A-Z0-9]{8,12}$/.test(channelId)) return `Error: "${channelId}" doesn't look like a valid Slack channel ID (expected C/D/G + 8-12 alphanumeric chars).`;

          const scheduleKind = (input.scheduleKind as string) ?? "every";
          let schedule: CronSchedule;

          if (scheduleKind === "at") {
            const atMs = input.atMs as number;
            if (!atMs || !Number.isFinite(atMs)) return "Error: atMs (epoch milliseconds) is required for one-shot reminders.";
            if (atMs <= Date.now()) return "Error: atMs must be in the future.";
            if (atMs > Date.now() + 365 * 86_400_000) return "Error: atMs is more than 1 year in the future — check the epoch value.";
            schedule = { kind: "at", atMs };
          } else {
            const everyMs = input.everyMs as number;
            if (!everyMs || !Number.isFinite(everyMs) || everyMs < 60_000) {
              return "Error: everyMs is required and must be at least 60000 (1 minute).";
            }
            if (everyMs > 30 * 86_400_000) {
              return "Error: everyMs exceeds 30 days — use a one-shot (scheduleKind=at) for events that far out.";
            }
            schedule = { kind: "every", everyMs, anchorMs: Date.now() };
          }

          const job = await cronService.add({
            name,
            message,
            channelId,
            agentId,
            schedule,
            enabled: true,
          });

          const nextRun = job.state.nextRunAtMs
            ? new Date(job.state.nextRunAtMs).toISOString()
            : "unknown";

          return `Reminder created:\n- ID: ${job.id}\n- Name: ${job.name}\n- Schedule: ${formatSchedule(job.schedule)}\n- Next run: ${nextRun}`;
        }

        case "list": {
          const jobs = await cronService.listAll();
          if (jobs.length === 0) return "No scheduled reminders.";

          const lines = jobs.map((j) => {
            const status = j.enabled ? "active" : "disabled";
            const next = j.state.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString() : "—";
            const lastRun = j.state.lastRunAtMs ? new Date(j.state.lastRunAtMs).toISOString() : "never";
            const lastStatus = j.state.lastStatus ? ` (${j.state.lastStatus}${j.state.lastError ? `: ${j.state.lastError.slice(0, 60)}` : ""})` : "";
            return `- [${status}] "${j.name}" (${j.id})\n  Schedule: ${formatSchedule(j.schedule)}\n  Next: ${next} | Last: ${lastRun}${lastStatus}\n  Channel: ${j.channelId}`;
          });
          return `Scheduled reminders (${jobs.length}):\n\n${lines.join("\n\n")}`;
        }

        case "remove": {
          const jobId = input.jobId as string;
          if (!jobId) return "Error: jobId is required.";

          const removed = await cronService.remove(jobId);
          return removed ? `Reminder ${jobId} removed.` : `No reminder found with ID ${jobId}.`;
        }

        case "update": {
          const jobId = input.jobId as string;
          if (!jobId) return "Error: jobId is required.";

          const patch: CronJobPatch = {};
          if (input.name !== undefined) patch.name = input.name as string;
          if (input.message !== undefined) patch.message = input.message as string;
          if (input.enabled !== undefined) patch.enabled = input.enabled as boolean;

          if (input.scheduleKind !== undefined) {
            if (input.scheduleKind === "at") {
              const atMs = input.atMs as number;
              if (!atMs) return "Error: atMs required for at schedule.";
              patch.schedule = { kind: "at", atMs };
            } else if (input.scheduleKind === "every") {
              const everyMs = input.everyMs as number;
              if (!everyMs || everyMs < 60_000) return "Error: everyMs must be >= 60000.";
              patch.schedule = { kind: "every", everyMs, anchorMs: Date.now() };
            }
          }

          const job = await cronService.update(jobId, patch);
          if (!job) return `No reminder found with ID ${jobId}.`;

          return `Reminder updated:\n- ID: ${job.id}\n- Name: ${job.name}\n- Enabled: ${job.enabled}\n- Schedule: ${formatSchedule(job.schedule)}`;
        }

        case "purge": {
          const jobs = await cronService.listAll();
          const includeActive = input.enabled === true; // purge with enabled=true removes ALL jobs
          const toPurge = includeActive ? jobs : jobs.filter((j) => !j.enabled);
          if (toPurge.length === 0) return includeActive ? "No jobs to purge." : "No disabled jobs to purge. Use enabled=true to purge all jobs.";
          let removed = 0;
          for (const j of toPurge) {
            if (await cronService.remove(j.id)) removed++;
          }
          return `Purged ${removed} ${includeActive ? "" : "disabled "}job(s).`;
        }

        default:
          return `Unknown action: ${action}. Use add, list, remove, update, or purge.`;
      }
    },
  };
}

function formatSchedule(schedule: CronSchedule): string {
  if (schedule.kind === "at") {
    return `one-shot at ${new Date(schedule.atMs).toISOString()}`;
  }
  return `every ${formatDuration(schedule.everyMs)}`;
}

