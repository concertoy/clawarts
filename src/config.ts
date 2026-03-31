import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import type { AgentConfig, AgentEntry, AgentDefaults, RootConfig } from "./types.js";

dotenv.config();

interface LegacyConfigFile {
  provider?: string;
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  skillsDirs?: string[];
  sessionTtlMinutes?: number;
  workspaceDir?: string;
  // Multi-agent fields
  defaults?: AgentDefaults;
  agents?: AgentEntry[];
}

function loadConfigFile(): LegacyConfigFile {
  const configPath = path.resolve("config.json");
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as LegacyConfigFile;
}

const AGENT_DEFAULTS: Required<AgentDefaults> = {
  provider: "openai-codex",
  model: "gpt-5.4",
  maxTokens: 8192,
  systemPrompt: "You are a helpful assistant in a Slack workspace.",
  skillsDirs: ["~/.clawarts/workspace/skills"],
  sessionTtlMinutes: 120,
  workspaceDir: path.join(os.homedir(), ".clawarts", "workspace"),
};

function expandTilde(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function resolveAgentConfig(entry: AgentEntry, defaults: AgentDefaults): AgentConfig {
  const workspaceDir = expandTilde(
    entry.workspaceDir
      ?? defaults.workspaceDir
      ?? path.join(os.homedir(), ".clawarts", "agents", entry.id, "workspace"),
  );

  return {
    id: entry.id,
    provider: (entry.provider ?? defaults.provider ?? AGENT_DEFAULTS.provider) as AgentConfig["provider"],
    model: entry.model ?? defaults.model ?? AGENT_DEFAULTS.model,
    maxTokens: entry.maxTokens ?? defaults.maxTokens ?? AGENT_DEFAULTS.maxTokens,
    systemPrompt: entry.systemPrompt ?? defaults.systemPrompt ?? AGENT_DEFAULTS.systemPrompt,
    skillsDirs: (entry.skillsDirs ?? defaults.skillsDirs ?? AGENT_DEFAULTS.skillsDirs).map(expandTilde),
    sessionTtlMinutes: entry.sessionTtlMinutes ?? defaults.sessionTtlMinutes ?? AGENT_DEFAULTS.sessionTtlMinutes,
    workspaceDir,
    slackBotToken: entry.slackBotToken,
    slackAppToken: entry.slackAppToken,
  };
}

/**
 * Load config. Supports two formats:
 *
 * Multi-agent (new):
 *   { "defaults": { ... }, "agents": [ { "id": "tutor", "slackBotToken": "...", ... } ] }
 *
 * Single-agent (legacy, uses env vars for Slack tokens):
 *   { "model": "gpt-5.4", "systemPrompt": "..." }
 */
export function loadAllAgentConfigs(): AgentConfig[] {
  const file = loadConfigFile();

  // Multi-agent mode
  if (file.agents && file.agents.length > 0) {
    const defaults = file.defaults ?? {};
    return file.agents.map((entry) => resolveAgentConfig(entry, defaults));
  }

  // Legacy single-agent mode (Slack tokens from env)
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!botToken || !appToken) {
    throw new Error("Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN. Set them in .env or use multi-agent config.");
  }

  return [
    {
      id: "default",
      provider: (file.provider ?? AGENT_DEFAULTS.provider) as AgentConfig["provider"],
      model: file.model ?? AGENT_DEFAULTS.model,
      maxTokens: file.maxTokens ?? AGENT_DEFAULTS.maxTokens,
      systemPrompt: file.systemPrompt ?? AGENT_DEFAULTS.systemPrompt,
      skillsDirs: (file.skillsDirs ?? AGENT_DEFAULTS.skillsDirs).map(expandTilde),
      sessionTtlMinutes: file.sessionTtlMinutes ?? AGENT_DEFAULTS.sessionTtlMinutes,
      workspaceDir: expandTilde(file.workspaceDir ?? AGENT_DEFAULTS.workspaceDir),
      slackBotToken: botToken,
      slackAppToken: appToken,
    },
  ];
}
