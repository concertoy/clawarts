import { loadAllAgentConfigs } from "./config.js";
import { TokenProvider } from "./auth.js";
import { loadSkills } from "./skills.js";
import { loadWorkspaceFiles } from "./workspace.js";
import { createToolRegistry } from "./tools.js";
import { SessionStore } from "./session.js";
import { Agent } from "./agent.js";
import { createSlackApp } from "./slack.js";
import { CodexProvider } from "./providers/codex.js";
import { ClaudeProvider } from "./providers/claude.js";
import type { ModelProvider } from "./provider.js";
import type { AgentConfig } from "./types.js";
import type { App } from "@slack/bolt";

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
      // Share a single TokenProvider across all Codex agents
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

  for (const config of agentConfigs) {
    const label = `[${config.id}]`;

    // Load skills and workspace files per agent
    const skills = loadSkills(config.skillsDirs);
    console.log(`${label} Skills: ${skills.map((s) => s.name).join(", ") || "(none)"}`);
    const workspaceFiles = loadWorkspaceFiles(config.workspaceDir);

    // Initialize per-agent components
    const tools = createToolRegistry(config.workspaceDir);
    const sessions = new SessionStore(config.sessionTtlMinutes * 60 * 1000);
    const provider = await createProvider(config);
    const agent = new Agent(config, provider, sessions, skills, tools, workspaceFiles);
    console.log(`${label} Provider: ${provider.name}, model: ${config.model}`);

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
