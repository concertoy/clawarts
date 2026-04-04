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
import { scaffoldWorkspace } from "./cli/scaffold.js";
import { runDiagnostics, checkProviderHealth, checkSlackTokens } from "./diagnostics.js";
import { registerAgent, createRelayTool, createListStudentsTool } from "./relay.js";
import { createSlackUploadTool } from "./slack-upload-tool.js";
import { errMsg } from "./utils/errors.js";
import { AssignmentStore } from "./store/assignment-store.js";
import { SubmissionStore } from "./store/submission-store.js";
import { createAssignmentTool } from "./tools/assignment-tool.js";
import { createSubmitTool } from "./tools/submit-tool.js";
import { CheckinStore } from "./store/checkin-store.js";
import { createCheckinTool } from "./tools/checkin-tool.js";
import { createCheckinRespondTool } from "./tools/checkin-respond-tool.js";
import { createStatusTool } from "./tools/status-tool.js";
import { createMyStatusTool } from "./tools/my-status-tool.js";
import { createHelpTool } from "./tools/help-tool.js";
import { createExportTool } from "./tools/export-tool.js";
import { createResetTool } from "./tools/reset-tool.js";

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
  // Read version from package.json for startup banner
  const pkgPath = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  console.log(`[clawarts] v${pkg.version} starting (node ${process.version}, pid ${process.pid})`);

  const agentConfigs = loadAllAgentConfigs();
  console.log(`[clawarts] ${agentConfigs.length} agent(s): ${agentConfigs.map((a) => a.id).join(", ")}`);
  runDiagnostics(agentConfigs);
  await Promise.all([checkProviderHealth(agentConfigs), checkSlackTokens(agentConfigs)]);

  const apps: App[] = [];
  const allSessions: SessionStore[] = [];
  const allCronServices: CronService[] = [];

  // ─── Phase 1: Create all agent components ──────────────────────────
  // Build agents first so we can register them all in the relay registry
  // before starting any Slack apps. The relay tool resolves targets at
  // call time, so it's safe to add it to the tools list before registration.

  interface AgentEntry {
    config: AgentConfig;
    agent: Agent;
    sessions: SessionStore;
    slackClient: WebClient;
    cronService: CronService;
  }

  const entries: AgentEntry[] = [];

  for (const config of agentConfigs) {
    const label = `[${config.id}]`;

    // Ensure workspace directory exists and scaffold template files if missing.
    fs.mkdirSync(config.workspaceDir, { recursive: true });
    if (!fs.existsSync(path.join(config.workspaceDir, "SOUL.md"))) {
      const agentType = config.linkedTutor ? "student" : "tutor";
      const { created } = scaffoldWorkspace(config.id, config.workspaceDir, agentType);
      if (created.length > 0) console.log(`${label} Scaffolded workspace: ${created.join(", ")}`);
    }

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

    // Add relay tool for tutor agents (agents that manage students).
    // The relay tool looks up targets from the registry at call time,
    // so it works even though other agents aren't registered yet.
    const isTutor = !config.linkedTutor;
    if (isTutor) {
      allTools.push(createRelayTool());
      allTools.push(createListStudentsTool());

      // Assignment management for tutors
      const dataDir = path.join(os.homedir(), ".clawarts", "agents", config.id, "data");
      const assignmentStore = new AssignmentStore(path.join(dataDir, "assignments.json"));
      const submissionStore = new SubmissionStore(path.join(dataDir, "submissions.json"));
      allTools.push(createAssignmentTool(assignmentStore, submissionStore, cronService, config.id));

      // Check-in management for tutors (data in tutor's directory)
      const checkinStore = new CheckinStore(dataDir);
      allTools.push(createCheckinTool(checkinStore, cronService, config.id));
      allTools.push(createStatusTool(cronService));
      allTools.push(createExportTool());
      allTools.push(createResetTool());

      // Wire system message handler for auto-close cron jobs
      cronService.setSystemMessageHandler(async (tag, params) => {
        if (tag === "CLOSE_ASSIGNMENT" && params.assignmentId) {
          await assignmentStore.close(params.assignmentId);
          console.log(`[cron:${config.id}] Auto-closed assignment ${params.assignmentId}`);
          return true;
        }
        if (tag === "CLOSE_CHECKIN" && params.windowId) {
          await checkinStore.closeWindow(params.windowId);
          console.log(`[cron:${config.id}] Auto-closed check-in ${params.windowId}`);
          return true;
        }
        if (tag === "PULSE_CHECKIN" && params.pulseGroupId) {
          const toInt = (v: string | undefined, fallback: number) => parseInt(v ?? "", 10) || fallback;
          const duration = toInt(params.durationMinutes, 2) * 60 * 1000;
          const pulseIndex = toInt(params.pulseIndex, 1);
          const pulseTotal = toInt(params.pulseTotal, 1);
          await checkinStore.createWindow({
            tutorId: config.id,
            mode: "pulse",
            topic: params.topic || undefined,
            pulseGroupId: params.pulseGroupId,
            pulseIndex,
            pulseTotal,
            closesAt: Date.now() + duration,
          });
          console.log(`[cron:${config.id}] Opened pulse ${pulseIndex}/${pulseTotal}`);
          return true;
        }
        return false;
      });
    } else if (config.linkedTutor) {
      // Student agents share the tutor's data stores (read assignments, write submissions)
      const tutorDataDir = path.join(os.homedir(), ".clawarts", "agents", config.linkedTutor, "data");
      const assignmentStore = new AssignmentStore(path.join(tutorDataDir, "assignments.json"));
      const submissionStore = new SubmissionStore(path.join(tutorDataDir, "submissions.json"));
      allTools.push(createSubmitTool(assignmentStore, submissionStore));

      // Check-in respond tool for students (reads/writes tutor's checkin store)
      const checkinStore = new CheckinStore(tutorDataDir);
      allTools.push(createCheckinRespondTool(checkinStore));
      allTools.push(createMyStatusTool(assignmentStore, submissionStore, checkinStore));
    }

    // Add Slack file upload tool (all agents can upload files to their conversation)
    allTools.push(createSlackUploadTool(slackClient));

    const tools = filterToolsForAgent(allTools, config);
    tools.push(createHelpTool(tools));
    const sessions = new SessionStore(config.sessionTtlMinutes * 60 * 1000);
    sessions.enablePersistence(path.join(os.homedir(), ".clawarts", "agents", config.id, "sessions"));
    const provider = await createProvider(config);
    const agent = new Agent(config, provider, sessions, skills, tools, workspaceFiles);
    const extras = [
      config.helpLevel ? `helpLevel=${config.helpLevel}` : "",
      config.quietHours ? `quietHours=${config.quietHours}${config.quietHoursTimezone ? ` (${config.quietHoursTimezone})` : ""}` : "",
      config.rateLimitPerMinute ? `rateLimit=${config.rateLimitPerMinute}/min` : "",
    ].filter(Boolean).join(", ");
    console.log(`${label} Provider: ${provider.name}, model: ${config.model}${extras ? `, ${extras}` : ""}`);
    console.log(`${label} Tools: ${tools.map((t) => t.name).join(", ")}`);

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
  console.log(`[clawarts] Relay registry: ${entries.map((e) => e.config.id).join(", ")}`);

  // ─── Phase 3: Start Slack apps and cron services ───────────────────
  for (const entry of entries) {
    const label = `[${entry.config.id}]`;

    const app = createSlackApp(entry.config, entry.agent, entry.sessions);
    try {
      await app.start();
    } catch (err) {
      throw new Error(`${label} Failed to start Slack Socket Mode — check that slackBotToken and slackAppToken are correct and that Socket Mode is enabled in your Slack app settings. Error: ${errMsg(err)}`);
    }
    // Resolve and log bot identity (best-effort)
    try {
      const auth = await entry.slackClient.auth.test();
      console.log(`${label} Slack bot running as @${auth.user} (Socket Mode)`);
    } catch {
      console.log(`${label} Slack bot running (Socket Mode)`);
    }

    await entry.cronService.start();

    apps.push(app);
    allSessions.push(entry.sessions);
    allCronServices.push(entry.cronService);
  }

  // Graceful shutdown (guarded against double-fire from SIGINT + SIGTERM)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[clawarts] Shutting down...");
    const cronResults = await Promise.allSettled(allCronServices.map((c) => c.stop()));
    for (const r of cronResults) {
      if (r.status === "rejected") console.warn("[clawarts] Cron stop error:", errMsg(r.reason));
    }
    console.log("[clawarts] Persisting sessions...");
    for (const s of allSessions) s.destroy();
    const appResults = await Promise.allSettled(apps.map((a) => a.stop()));
    for (const r of appResults) {
      if (r.status === "rejected") console.warn("[clawarts] Slack app stop error:", errMsg(r.reason));
    }
    console.log("[clawarts] Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Global error handlers — prevent silent crashes.
// Ported from claude-code's global error handling pattern.
process.on("unhandledRejection", (reason) => {
  console.error("[clawarts] Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[clawarts] Uncaught exception:", err);
  process.exit(1);
});

main().catch((err) => {
  console.error("[clawarts] Fatal error:", err);
  process.exit(1);
});
