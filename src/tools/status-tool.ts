import type { ToolDefinition, ToolUseContext } from "../types.js";
import { getStudentsForTutor, getAgentLastActive } from "../relay.js";
import type { CronService } from "../cron/service.js";

/**
 * Status tool for tutors — quick overview of student agents and scheduled jobs.
 */
export function createStatusTool(cronService: CronService): ToolDefinition {
  return {
    name: "status",
    description:
      "Show a quick overview: student agents (online/last active), upcoming cron jobs, and system health.",
    parameters: { type: "object", properties: {} },
    isReadOnly: true,
    category: "utility",

    async execute(_input: Record<string, unknown>, context?: ToolUseContext): Promise<string> {
      const tutorId = context?.agentId ?? "unknown";
      const lines: string[] = [`Status for ${tutorId}:`];

      // Student agents
      const students = getStudentsForTutor(tutorId);
      if (students.length > 0) {
        lines.push(`\nStudents (${students.length}):`);
        for (const s of students) {
          const active = getAgentLastActive(s.id);
          const ago = active ? `${Math.round((Date.now() - active) / 60_000)}m ago` : "never";
          const users = s.allowedUsers.map((u) => `<@${u}>`).join(", ") || "(none)";
          lines.push(`  ${s.id}: last active ${ago}, users: ${users}`);
        }
      } else {
        lines.push("\nNo student agents linked.");
      }

      // Upcoming cron jobs
      const jobs = await cronService.listAll();
      const enabled = jobs.filter((j) => j.enabled);
      if (enabled.length > 0) {
        lines.push(`\nCron jobs (${enabled.length} enabled, ${jobs.length - enabled.length} disabled):`);
        for (const j of enabled.slice(0, 10)) {
          const next = j.state.nextRunAtMs
            ? new Date(j.state.nextRunAtMs).toISOString()
            : "not scheduled";
          lines.push(`  ${j.name || j.id}: next ${next}`);
        }
        if (enabled.length > 10) lines.push(`  ... and ${enabled.length - 10} more`);
      } else {
        lines.push("\nNo cron jobs scheduled.");
      }

      return lines.join("\n");
    },
  };
}
