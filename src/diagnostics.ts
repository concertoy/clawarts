import fs from "node:fs";
import type { AgentConfig } from "./types.js";

/**
 * Startup diagnostics. Runs after config is loaded but before agents connect.
 * Warns about misconfigurations that would cause silent runtime failures.
 */
export function runDiagnostics(configs: AgentConfig[]): void {
  const warnings: string[] = [];

  for (const config of configs) {
    const label = config.id;

    // Check agent ID format
    if (!/^[a-z0-9_-]+$/.test(config.id)) {
      warnings.push(`${label}: agent ID should be lowercase alphanumeric with hyphens/underscores`);
    }

    // Check workspace exists
    if (!fs.existsSync(config.workspaceDir)) {
      warnings.push(`${label}: workspace "${config.workspaceDir}" will be created on start`);
    }

    // Check linked tutor exists
    if (config.linkedTutor) {
      const tutorExists = configs.some((c) => c.id === config.linkedTutor);
      if (!tutorExists) {
        warnings.push(`${label}: linkedTutor "${config.linkedTutor}" not found in config — relay will fail`);
      }
    }

    // Check for student agents without linkedTutor
    if (config.disallowedTools?.length && !config.linkedTutor) {
      warnings.push(`${label}: has disallowedTools but no linkedTutor — is this a student agent missing its tutor link?`);
    }

    // Check allowedUsers configured
    if (!config.allowedUsers || config.allowedUsers.length === 0) {
      warnings.push(`${label}: no allowedUsers configured — any Slack user can interact with this agent`);
    }

    // Duplicate Slack bot tokens (two agents sharing the same bot)
    const sameBot = configs.filter((c) => c.id !== config.id && c.slackBotToken === config.slackBotToken);
    if (sameBot.length > 0) {
      warnings.push(`${label}: shares slackBotToken with ${sameBot.map((c) => c.id).join(", ")} — each agent should have its own Slack app`);
    }
  }

  // Check for tutor agents without any students
  const tutors = configs.filter((c) => !c.linkedTutor);
  for (const tutor of tutors) {
    const students = configs.filter((c) => c.linkedTutor === tutor.id);
    if (students.length === 0 && configs.length > 1) {
      warnings.push(`${tutor.id}: tutor agent has no linked students`);
    }
  }

  if (warnings.length > 0) {
    console.warn(`[clawarts] ⚠ Startup diagnostics (${warnings.length} warning${warnings.length > 1 ? "s" : ""}):`);
    for (const w of warnings) {
      console.warn(`  - ${w}`);
    }
  }
}
