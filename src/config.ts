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

const AGENT_DEFAULTS = {
  provider: "openai-codex",
  model: "gpt-5.4",
  maxTokens: 8192,
  systemPrompt: "You are a helpful assistant in a Slack workspace.",
  sessionTtlMinutes: 120,
};

const DEFAULT_MODELS: Record<string, string> = {
  "openai-codex": "gpt-5.4",
  "anthropic-claude": "claude-sonnet-4-20250514",
};

function expandTilde(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** Resolve a value that may be a $ENV_VAR reference. */
function resolveEnvRef(value: string): string {
  if (value.startsWith("$")) {
    const envName = value.slice(1);
    const envValue = process.env[envName];
    if (!envValue) throw new Error(`Environment variable ${envName} is not set (referenced in config.json)`);
    return envValue;
  }
  return value;
}

const VALID_PROVIDERS = new Set(["openai-codex", "anthropic-claude"]);

function validateAgentConfig(config: AgentConfig): void {
  const errors: string[] = [];

  if (!config.id) errors.push("id is required");
  if (!VALID_PROVIDERS.has(config.provider)) {
    errors.push(`provider "${config.provider}" is not valid. Use: ${[...VALID_PROVIDERS].join(", ")}`);
  }
  if (!config.slackBotToken) errors.push("slackBotToken is required (or its $ENV_VAR must be set)");
  if (!config.slackAppToken) errors.push("slackAppToken is required (or its $ENV_VAR must be set)");
  if (config.maxTokens < 1) errors.push("maxTokens must be positive");
  if (config.sessionTtlMinutes < 1) errors.push("sessionTtlMinutes must be positive");
  if (config.thinkingBudgetTokens !== undefined && config.thinkingBudgetTokens < 0) {
    errors.push("thinkingBudgetTokens must be non-negative");
  }

  if (config.provider === "anthropic-claude" && !process.env.ANTHROPIC_API_KEY) {
    errors.push("ANTHROPIC_API_KEY environment variable is required for anthropic-claude provider");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid config for agent "${config.id}":\n  - ${errors.join("\n  - ")}`);
  }
}

function resolveAgentConfig(entry: AgentEntry, defaults: AgentDefaults): AgentConfig {
  const agentBase = path.join(os.homedir(), ".clawarts", "agents", entry.id);
  const workspaceDir = expandTilde(
    entry.workspaceDir ?? defaults.workspaceDir ?? path.join(agentBase, "workspace"),
  );
  const defaultSkillsDirs = [path.join(workspaceDir, "skills")];

  return {
    id: entry.id,
    provider: (entry.provider ?? defaults.provider ?? AGENT_DEFAULTS.provider) as AgentConfig["provider"],
    model: entry.model ?? defaults.model ?? DEFAULT_MODELS[entry.provider ?? defaults.provider ?? AGENT_DEFAULTS.provider] ?? AGENT_DEFAULTS.model,
    maxTokens: entry.maxTokens ?? defaults.maxTokens ?? AGENT_DEFAULTS.maxTokens,
    systemPrompt: entry.systemPrompt ?? defaults.systemPrompt ?? AGENT_DEFAULTS.systemPrompt,
    skillsDirs: (entry.skillsDirs ?? defaults.skillsDirs ?? defaultSkillsDirs).map(expandTilde),
    sessionTtlMinutes: entry.sessionTtlMinutes ?? defaults.sessionTtlMinutes ?? AGENT_DEFAULTS.sessionTtlMinutes,
    workspaceDir,
    slackBotToken: resolveEnvRef(entry.slackBotToken),
    slackAppToken: resolveEnvRef(entry.slackAppToken),
    allowedTools: entry.allowedTools ?? defaults.allowedTools,
    disallowedTools: entry.disallowedTools ?? defaults.disallowedTools,
    thinkingBudgetTokens: entry.thinkingBudgetTokens ?? defaults.thinkingBudgetTokens,
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
    const configs = file.agents.map((entry) => resolveAgentConfig(entry, defaults));
    for (const config of configs) validateAgentConfig(config);
    return configs;
  }

  // Legacy single-agent mode (Slack tokens from env)
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!botToken || !appToken) {
    throw new Error("Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN. Set them in .env or use multi-agent config.");
  }

  const agentBase = path.join(os.homedir(), ".clawarts", "agents", "default");
  const workspaceDir = expandTilde(file.workspaceDir ?? path.join(agentBase, "workspace"));
  const defaultSkillsDirs = [path.join(workspaceDir, "skills")];

  const config: AgentConfig = {
    id: "default",
    provider: (file.provider ?? AGENT_DEFAULTS.provider) as AgentConfig["provider"],
    model: file.model ?? AGENT_DEFAULTS.model,
    maxTokens: file.maxTokens ?? AGENT_DEFAULTS.maxTokens,
    systemPrompt: file.systemPrompt ?? AGENT_DEFAULTS.systemPrompt,
    skillsDirs: (file.skillsDirs ?? defaultSkillsDirs).map(expandTilde),
    sessionTtlMinutes: file.sessionTtlMinutes ?? AGENT_DEFAULTS.sessionTtlMinutes,
    workspaceDir,
    slackBotToken: botToken,
    slackAppToken: appToken,
  };
  validateAgentConfig(config);
  return [config];
}
