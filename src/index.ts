import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAllAgentConfigs } from "./config.js";
import { TokenProvider } from "./auth.js";
import { loadSkills } from "./skills.js";
import { loadWorkspaceFiles } from "./workspace.js";
import { SessionStore } from "./session.js";
import { Agent } from "./agent.js";
import { createSlackApp } from "./slack.js";
import { CodexProvider } from "./providers/codex.js";
import { ClaudeProvider } from "./providers/claude.js";
import { CronService } from "./cron/service.js";
import type { ModelProvider } from "./provider.js";
import type { AgentConfig } from "./types.js";
import type { App } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { scaffoldWorkspace } from "./cli/scaffold.js";
import { runDiagnostics, checkProviderHealth, checkSlackTokens } from "./diagnostics.js";
import { registerAgent } from "./relay.js";
import { errMsg } from "./utils/errors.js";
import { createAgentTools } from "./agent-tools.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("clawarts");

// ─── Provider construction ────────────────────────────────────────────

let sharedTokenProvider: TokenProvider | null = null;

async function createProvider(config: AgentConfig): Promise<ModelProvider> {
  switch (config.provider) {
    case "anthropic-claude": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY environment variable is required for anthropic-claude provider");
      return new ClaudeProvider(apiKey);
    }
    case "openai-codex": {
      if (!sharedTokenProvider) {
        sharedTokenProvider = new TokenProvider(config.provider);
        await sharedTokenProvider.init();
      }
      return new CodexProvider(sharedTokenProvider);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  (globalThis as Record<string, unknown>).__clawarts_start_ms = Date.now();

  // Read version from package.json for startup banner
  const pkgPath = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  log.info(`v${pkg.version} starting (node ${process.version}, pid ${process.pid})`);

  const agentConfigs = loadAllAgentConfigs();
  log.info(`${agentConfigs.length} agent(s): ${agentConfigs.map((a) => a.id).join(", ")}`);
  runDiagnostics(agentConfigs);
  await Promise.all([checkProviderHealth(agentConfigs), checkSlackTokens(agentConfigs)]);

  const apps: App[] = [];
  const allSessions: SessionStore[] = [];
  const allCronServices: CronService[] = [];

  // ─── Phase 1: Create all agent components ──────────────────────────

  interface AgentEntry {
    config: AgentConfig;
    agent: Agent;
    sessions: SessionStore;
    slackClient: WebClient;
    cronService: CronService;
  }

  const entries: AgentEntry[] = [];

  for (const config of agentConfigs) {
    const alog = createLogger(config.id);

    // Ensure workspace directory exists and scaffold template files if missing.
    fs.mkdirSync(config.workspaceDir, { recursive: true });
    if (!fs.existsSync(path.join(config.workspaceDir, "SOUL.md"))) {
      const agentType = config.linkedTutor ? "student" : "tutor";
      const { created } = scaffoldWorkspace(config.id, config.workspaceDir, agentType);
      if (created.length > 0) alog.info(`Scaffolded workspace: ${created.join(", ")}`);
    }

    // Load skills and workspace files per agent
    const skills = loadSkills({
      ...config.skillSources,
      legacyDirs: config.skillsDirs,
    });
    alog.info(`Skills: ${skills.map((s) => s.name).join(", ") || "(none)"}`);
    const workspaceFiles = loadWorkspaceFiles(config.workspaceDir);

    // Create Slack WebClient for cron delivery (before App, avoids chicken-and-egg)
    const slackClient = new WebClient(config.slackBotToken);

    // Create cron service per agent
    const cronStorePath = path.join(os.homedir(), ".clawarts", "agents", config.id, "cron", "jobs.json");
    const cronService = new CronService({
      agentId: config.id,
      storePath: cronStorePath,
      slackClient,
    });

    // Initialize per-agent components (cron tool wired into registry, then filtered)
    const { tools, cronSystemHandler } = createAgentTools(config, cronService, slackClient);
    if (cronSystemHandler) {
      cronService.setSystemMessageHandler(async (tag, params) => {
        const handled = await cronSystemHandler(tag, params);
        if (handled) alog.info(`Cron system action: ${tag}`);
        return handled;
      });
    }

    const sessions = new SessionStore(config.sessionTtlMinutes * 60 * 1000);
    sessions.enablePersistence(path.join(os.homedir(), ".clawarts", "agents", config.id, "sessions"));
    const provider = await createProvider(config);
    const agent = new Agent(config, provider, sessions, skills, tools, workspaceFiles);
    const extras = [
      config.helpLevel ? `helpLevel=${config.helpLevel}` : "",
      config.quietHours ? `quietHours=${config.quietHours}${config.quietHoursTimezone ? ` (${config.quietHoursTimezone})` : ""}` : "",
      config.rateLimitPerMinute ? `rateLimit=${config.rateLimitPerMinute}/min` : "",
    ].filter(Boolean).join(", ");
    alog.info(`Provider: ${provider.name}, model: ${config.model}${extras ? `, ${extras}` : ""}`);
    alog.info(`Tools: ${tools.map((t) => t.name).join(", ")}`);

    entries.push({ config, agent, sessions, slackClient, cronService });
  }

  // ─── Phase 2: Register all agents in relay registry ────────────────
  for (const entry of entries) {
    registerAgent({
      id: entry.config.id,
      agent: entry.agent,
      sessions: entry.sessions,
      slackClient: entry.slackClient,
      linkedTutor: entry.config.linkedTutor,
      allowedUsers: entry.config.allowedUsers,
    });
  }
  log.info(`Relay registry: ${entries.map((e) => e.config.id).join(", ")}`);

  // ─── Phase 3: Start Slack apps and cron services ───────────────────
  for (const entry of entries) {
    const alog = createLogger(entry.config.id);

    const app = createSlackApp(entry.config, entry.agent, entry.sessions);
    try {
      await app.start();
    } catch (err) {
      throw new Error(`[${entry.config.id}] Failed to start Slack Socket Mode — check that slackBotToken and slackAppToken are correct and that Socket Mode is enabled in your Slack app settings. Error: ${errMsg(err)}`);
    }
    // Resolve and log bot identity (best-effort)
    try {
      const auth = await entry.slackClient.auth.test();
      alog.info(`Slack bot running as @${auth.user} (Socket Mode)`);
    } catch {
      alog.info("Slack bot running (Socket Mode)");
    }

    await entry.cronService.start();

    apps.push(app);
    allSessions.push(entry.sessions);
    allCronServices.push(entry.cronService);
  }

  // Startup complete
  const tutors = entries.filter((e) => !e.config.linkedTutor).length;
  const students = entries.length - tutors;
  const elapsedMs = Date.now() - ((globalThis as Record<string, unknown>).__clawarts_start_ms as number ?? Date.now());
  log.info(`Ready: ${tutors} tutor(s), ${students} student(s) — startup took ${(elapsedMs / 1000).toFixed(1)}s`);

  // Graceful shutdown (guarded against double-fire from SIGINT + SIGTERM)
  const SHUTDOWN_TIMEOUT_MS = 10_000;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutting down...");
    // Force-exit if graceful shutdown hangs
    const forceTimer = setTimeout(() => {
      log.error(`Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS / 1000}s — forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    if (forceTimer.unref) forceTimer.unref();

    const cronResults = await Promise.allSettled(allCronServices.map((c) => c.stop()));
    for (const r of cronResults) {
      if (r.status === "rejected") log.warn("Cron stop error:", errMsg(r.reason));
    }
    log.info("Persisting sessions...");
    for (const s of allSessions) s.destroy();
    const appResults = await Promise.allSettled(apps.map((a) => a.stop()));
    for (const r of appResults) {
      if (r.status === "rejected") log.warn("Slack app stop error:", errMsg(r.reason));
    }
    clearTimeout(forceTimer);
    log.info("Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Global error handlers — prevent silent crashes.
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  log.error("Uncaught exception:", err);
  process.exit(1);
});

main().catch((err) => {
  log.error("Fatal error:", err);
  process.exit(1);
});
