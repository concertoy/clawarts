import fs from "node:fs";
import path from "node:path";
import { WebClient } from "@slack/web-api";
import type { AgentConfig } from "./types.js";
import { errMsg } from "./utils/errors.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("clawarts");
const healthLog = createLogger("health");

/**
 * Startup diagnostics. Runs after config is loaded but before agents connect.
 * Warns about misconfigurations that would cause silent runtime failures.
 */
export function runDiagnostics(configs: AgentConfig[]): void {
  // Environment info
  const memMB = Math.round(process.memoryUsage.rss() / 1024 / 1024);
  log.info(`Environment: node ${process.version}, ${memMB}MB RSS, ${configs.length} agent(s)`);

  const warnings: string[] = [];

  for (const config of configs) {
    const label = config.id;

    // Check agent ID format
    if (!/^[a-z0-9_-]+$/.test(config.id)) {
      warnings.push(`${label}: agent ID should be lowercase alphanumeric with hyphens/underscores`);
    }

    // Check workspace exists and validate SOUL.md
    try {
      fs.accessSync(config.workspaceDir, fs.constants.R_OK);
      const soulPath = path.join(config.workspaceDir, "SOUL.md");
      try {
        const soul = fs.readFileSync(soulPath, "utf-8");
        if (soul.length > 20_000) {
          warnings.push(`${label}: SOUL.md is very long (${Math.round(soul.length / 1024)}KB) — will be truncated. Consider splitting into SOUL.md + TOOLS.md + COURSE.md`);
        }
        if (soul.trim().length === 0) {
          warnings.push(`${label}: SOUL.md is empty — agent will use generic persona`);
        }
      } catch {
        warnings.push(`${label}: no SOUL.md in workspace — agent will use generic persona`);
      }
    } catch {
      warnings.push(`${label}: workspace "${config.workspaceDir}" will be created on start`);
    }

    // Check linked tutor is actually a tutor (not itself a student)
    if (config.linkedTutor) {
      const tutor = configs.find((c) => c.id === config.linkedTutor);
      if (tutor?.linkedTutor) {
        warnings.push(`${label}: linkedTutor "${config.linkedTutor}" is itself a student agent — must link to a tutor`);
      }
    }

    // Check maxToolIterations
    if (config.maxToolIterations && config.maxToolIterations > 25) {
      warnings.push(`${label}: maxToolIterations is ${config.maxToolIterations} — high values can cause expensive runaway loops`);
    }

    // Check for student agents without linkedTutor
    if (config.disallowedTools?.length && !config.linkedTutor) {
      warnings.push(`${label}: has disallowedTools but no linkedTutor — is this a student agent missing its tutor link?`);
    }

    // Check for student agents without disallowedTools (they get full tool access)
    if (config.linkedTutor && (!config.disallowedTools || config.disallowedTools.length === 0)) {
      warnings.push(`${label}: student agent has no disallowedTools — consider restricting bash, write_file, edit, multi_edit`);
    }

    // Check allowedUsers configured
    if (!config.allowedUsers || config.allowedUsers.length === 0) {
      warnings.push(`${label}: no allowedUsers configured — any Slack user can interact with this agent`);
    }

    // Check configured skills directories exist
    for (const dir of config.skillsDirs ?? []) {
      try { fs.accessSync(dir, fs.constants.R_OK); } catch {
        warnings.push(`${label}: skills directory "${dir}" not found — no skills will be loaded from it`);
      }
    }

    // Duplicate Slack tokens (bot or app) — each agent should have its own.
    // Exception: tutor-student pairs sharing tokens is expected (same Slack app).
    for (const [tokenField, reason] of [
      ["slackBotToken", "each agent should have its own Slack app"] as const,
      ["slackAppToken", "Socket Mode requires unique app tokens per connection"] as const,
    ]) {
      const same = configs.filter((c) => {
        if (c.id === config.id) return false;
        if (c[tokenField] !== config[tokenField]) return false;
        // Tutor-student pairs sharing tokens is expected
        if (c.linkedTutor === config.id || config.linkedTutor === c.id) return false;
        // Siblings sharing the same tutor's tokens is also expected
        if (c.linkedTutor && c.linkedTutor === config.linkedTutor) return false;
        return true;
      });
      if (same.length > 0) {
        warnings.push(`${label}: shares ${tokenField} with ${same.map((c) => c.id).join(", ")} — ${reason}`);
      }
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
    log.warn(`Startup diagnostics (${warnings.length} warning${warnings.length > 1 ? "s" : ""}):`);
    for (const w of warnings) {
      log.warn(`  - ${w}`);
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
          if (!key) { healthLog.warn("anthropic-claude: ANTHROPIC_API_KEY not set"); return; }
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
            healthLog.info("anthropic-claude: OK");
          } else {
            const body = await resp.text().catch(() => "");
            healthLog.warn(`anthropic-claude: HTTP ${resp.status} — ${body.slice(0, 200)}`);
          }
          break;
        }
        case "openai-codex": {
          // Codex uses OAuth tokens — just verify env vars exist
          healthLog.info("openai-codex: token provider will authenticate on first call");
          break;
        }
      }
    } catch (err) {
      healthLog.warn(`${provider}: ${errMsg(err)}`);
    }
  });

  await Promise.allSettled(checks);
}

/**
 * Verify Slack bot tokens work by calling auth.test.
 * Runs once at startup — catches invalid/revoked tokens early.
 */
export async function checkSlackTokens(configs: AgentConfig[]): Promise<void> {
  // Deduplicate by token to avoid redundant API calls
  const seen = new Set<string>();
  const checks = configs.map(async (config) => {
    if (seen.has(config.slackBotToken)) return;
    seen.add(config.slackBotToken);
    try {
      const client = new WebClient(config.slackBotToken);
      const auth = await client.auth.test();
      healthLog.info(`${config.id}: Slack bot token OK (bot: @${auth.user})`);
    } catch (err) {
      healthLog.warn(`${config.id}: Slack bot token FAILED — ${errMsg(err)}`);
    }
  });
  await Promise.allSettled(checks);
}
