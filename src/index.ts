import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAllAgentConfigs } from "./config.js";
import { TokenProvider } from "./auth.js";
import { loadSkills } from "./skills.js";
import { loadWorkspaceFiles } from "./workspace.js";
import { createToolRegistry } from "./tools.js";
import { filterToolsForAgent } from "./tool-filter.js";
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

// ─── Provider construction ────────────────────────────────────────────

let sharedTokenProvider: TokenProvider | null = null;

async function createProvider(config: AgentConfig): Promise<ModelProvider> {
  switch (config.provider) {
    case "anthropic-claude": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY environment variable is required for anthropic-claude provider");
      return new ClaudeProvider(apiKey);
    }
    case "openai-codex":
    default: {
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
  console.log("[clawarts] Starting...");

  const agentConfigs = loadAllAgentConfigs();
  console.log(`[clawarts] ${agentConfigs.length} agent(s): ${agentConfigs.map((a) => a.id).join(", ")}`);

  const apps: App[] = [];
  const allSessions: SessionStore[] = [];
  const allCronServices: CronService[] = [];

  for (const config of agentConfigs) {
    const label = `[${config.id}]`;

    // Ensure workspace directory exists — ported from claude-code's workspace init pattern.
    // Prevents tool failures when the workspace hasn't been created yet.
    fs.mkdirSync(config.workspaceDir, { recursive: true });

    // Load skills and workspace files per agent
    const skills = loadSkills({
      ...config.skillSources,
      legacyDirs: config.skillsDirs,
    });
    console.log(`${label} Skills: ${skills.map((s) => s.name).join(", ") || "(none)"}`);
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
    const allTools = createToolRegistry(config.workspaceDir, { cronService, agentId: config.id });
    const tools = filterToolsForAgent(allTools, config);
    const sessions = new SessionStore(config.sessionTtlMinutes * 60 * 1000);
    const provider = await createProvider(config);
    const agent = new Agent(config, provider, sessions, skills, tools, workspaceFiles);
    console.log(`${label} Provider: ${provider.name}, model: ${config.model}, tools: ${tools.map((t) => t.name).join(", ")}`);

    // Create and start Slack app
    const app = createSlackApp(config, agent, sessions);
    await app.start();
    console.log(`${label} Slack bot running (Socket Mode)`);

    // Start cron scheduler (loads persisted jobs, arms timer)
    await cronService.start();

    apps.push(app);
    allSessions.push(sessions);
    allCronServices.push(cronService);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[clawarts] Shutting down...");
    for (const c of allCronServices) c.stop();
    for (const s of allSessions) s.destroy();
    for (const a of apps) await a.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Catch unhandled rejections — prevents silent crashes.
// Ported from claude-code's global error handling pattern.
process.on("unhandledRejection", (reason) => {
  console.error("[clawarts] Unhandled rejection:", reason);
});

main().catch((err) => {
  console.error("[clawarts] Fatal error:", err);
  process.exit(1);
});
