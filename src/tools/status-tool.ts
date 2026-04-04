import fs from "node:fs";
import type { ToolDefinition, ToolUseContext } from "../types.js";
import { getStudentsForTutor, getAgentLastActive, getAgentLastError, getRegisteredAgent } from "../relay.js";
import { getLaneDepth } from "../queue/command-queue.js";
import { CommandLane } from "../queue/lanes.js";
import type { CronService } from "../cron/service.js";
import { getTokenUsage, estimateCost, formatLatencyStats, getToolUsage } from "../utils/token-tracker.js";
import { formatTokenCount, formatUsd } from "../utils/format.js";

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
      const uptimeMin = Math.round(process.uptime() / 60);
      const memMB = Math.round(process.memoryUsage.rss() / 1024 / 1024);

      // Read version from package.json
      let version = "?";
      try {
        const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
        version = pkg.version ?? "?";
      } catch { /* non-fatal */ }
      const tutorReg = getRegisteredAgent(tutorId);
      const tutorSessions = tutorReg?.sessions.size ?? 0;
      const tutorTokens = getTokenUsage(tutorId);
      const latencyInfo = tutorTokens ? formatLatencyStats(tutorTokens) : "";
      const tokenInfo = tutorTokens
        ? `, ${formatTokenCount(tutorTokens.inputTokens)}in/${formatTokenCount(tutorTokens.outputTokens)}out (${tutorTokens.requestCount} req, ~${formatUsd(estimateCost(tutorTokens))}${latencyInfo ? `, ${latencyInfo}` : ""})`
        : "";
      const lines: string[] = [`Status for ${tutorId} v${version} (uptime: ${uptimeMin}m, ${memMB}MB, ${tutorSessions} session(s)${tokenInfo}):`];

      // Student agents
      const students = getStudentsForTutor(tutorId);
      if (students.length > 0) {
        lines.push(`\nStudents (${students.length}):`);
        for (const s of students) {
          const active = getAgentLastActive(s.id);
          const ago = active ? `${Math.round((Date.now() - active) / 60_000)}m ago` : "never";
          const users = s.allowedUsers.map((u) => `<@${u}>`).join(", ") || "(none)";
          const reg = getRegisteredAgent(s.id);
          const sessionCount = reg?.sessions.size ?? 0;
          const lastErr = getAgentLastError(s.id);
          const errNote = lastErr ? ` [last error: ${lastErr.slice(0, 80)}]` : "";
          const sTokens = getTokenUsage(s.id);
          const sTokenInfo = sTokens ? `, ${formatTokenCount(sTokens.inputTokens)}in/${formatTokenCount(sTokens.outputTokens)}out (~${formatUsd(estimateCost(sTokens))})` : "";
          lines.push(`  ${s.id}: last active ${ago}, ${sessionCount} session(s), users: ${users}${sTokenInfo}${errNote}`);
        }
      } else {
        lines.push("\nNo student agents linked.");
      }

      // Queue health
      const mainDepth = getLaneDepth(CommandLane.Main);
      const cronDepth = getLaneDepth(CommandLane.Cron);
      if (mainDepth > 0 || cronDepth > 0) {
        lines.push(`\nQueues: main=${mainDepth}, cron=${cronDepth}`);
      }

      // Cron service health
      lines.push(`\nCron: ${cronService.isRunning ? "running" : "stopped"}`);

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

      // Top tool usage across all agents
      const allToolUsage = new Map<string, number>();
      for (const id of [tutorId, ...students.map((s) => s.id)]) {
        for (const { name, count } of getToolUsage(id)) {
          allToolUsage.set(name, (allToolUsage.get(name) ?? 0) + count);
        }
      }
      if (allToolUsage.size > 0) {
        const top = [...allToolUsage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        lines.push(`\nTop tools: ${top.map(([n, c]) => `${n}(${c})`).join(", ")}`);
      }

      // Workspace files
      if (tutorReg) {
        const wFiles = tutorReg.agent.workspaceFiles;
        if (wFiles.length > 0) {
          const fileList = wFiles.map((f) => `${f.name} (${f.content.length} chars)`).join(", ");
          lines.push(`\nWorkspace files: ${fileList}`);
        }
      }

      // Total class cost estimate (tutor + all students)
      let totalCost = tutorTokens ? estimateCost(tutorTokens) : 0;
      for (const s of students) {
        const t = getTokenUsage(s.id);
        if (t) totalCost += estimateCost(t);
      }
      if (totalCost > 0) {
        lines.push(`\nEstimated total cost (this session): ~${formatUsd(totalCost)}`);
      }

      return lines.join("\n");
    },
  };
}
