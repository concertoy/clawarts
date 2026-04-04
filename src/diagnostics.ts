import fs from "node:fs";
import path from "node:path";
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
    } else if (!fs.existsSync(path.join(config.workspaceDir, "SOUL.md"))) {
      warnings.push(`${label}: no SOUL.md in workspace — agent will use generic persona`);
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
    console.warn(`[clawarts] Startup diagnostics (${warnings.length} warning${warnings.length > 1 ? "s" : ""}):`);
    for (const w of warnings) {
      console.warn(`  - ${w}`);
    }
  }
}

/**
 * Test API provider connectivity. Runs in parallel for all unique providers.
 * Logs pass/fail — doesn't throw (non-blocking).
 */
export async function checkProviderHealth(configs: AgentConfig[]): Promise<void> {
  const providers = new Set(configs.map((c) => c.provider));

  const checks = [...providers].map(async (provider) => {
    try {
      switch (provider) {
        case "anthropic-claude": {
          const key = process.env.ANTHROPIC_API_KEY;
          if (!key) { console.warn(`[health] anthropic-claude: ANTHROPIC_API_KEY not set`); return; }
          const resp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
            signal: AbortSignal.timeout(10_000),
          });
          if (resp.ok) {
            console.log(`[health] anthropic-claude: OK`);
          } else {
            const body = await resp.text().catch(() => "");
            console.warn(`[health] anthropic-claude: HTTP ${resp.status} — ${body.slice(0, 200)}`);
          }
          break;
        }
        case "openai-codex": {
          // Codex uses OAuth tokens — just verify env vars exist
          console.log(`[health] openai-codex: token provider will authenticate on first call`);
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[health] ${provider}: ${msg}`);
    }
  });

  await Promise.allSettled(checks);
}
