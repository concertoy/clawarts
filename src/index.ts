import { loadAllAgentConfigs } from "./config.js";
import { TokenProvider } from "./auth.js";
import { loadSkills } from "./skills.js";
import { loadWorkspaceFiles } from "./workspace.js";
import { createToolRegistry } from "./tools.js";
import { SessionStore } from "./session.js";
import { Agent } from "./agent.js";
import { createSlackApp } from "./slack.js";
import type { App } from "@slack/bolt";

async function main() {
  console.log("[clawarts] Starting...");

  const agentConfigs = loadAllAgentConfigs();
  console.log(`[clawarts] ${agentConfigs.length} agent(s): ${agentConfigs.map((a) => a.id).join(", ")}`);

  // Shared OAuth token provider (all agents use the same LLM provider)
  const tokenProvider = new TokenProvider(agentConfigs[0].provider);
  await tokenProvider.init();

  const apps: App[] = [];
  const allSessions: SessionStore[] = [];

  for (const config of agentConfigs) {
    const label = `[${config.id}]`;

    // Load skills and workspace files per agent
    const skills = loadSkills(config.skillsDirs);
    console.log(`${label} Skills: ${skills.map((s) => s.name).join(", ") || "(none)"}`);
    const workspaceFiles = loadWorkspaceFiles(config.workspaceDir);

    // Initialize per-agent components
    const tools = createToolRegistry(config.workspaceDir);
    const sessions = new SessionStore(config.sessionTtlMinutes * 60 * 1000);
    const agent = new Agent(config, tokenProvider, sessions, skills, tools, workspaceFiles);

    // Create and start Slack app
    const app = createSlackApp(config, agent, sessions);
    await app.start();
    console.log(`${label} Slack bot running (Socket Mode)`);

    apps.push(app);
    allSessions.push(sessions);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[clawarts] Shutting down...");
    for (const s of allSessions) s.destroy();
    for (const a of apps) await a.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[clawarts] Fatal error:", err);
  process.exit(1);
});
