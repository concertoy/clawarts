import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { AgentConfig, AgentEntry, AgentDefaults, Provider, SkillSources } from "./types.js";
import { errMsg, isFileNotFound } from "./utils/errors.js";
import { expandTilde, clawHome } from "./utils/paths.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("clawarts");

dotenv.config();

interface LegacyConfigFile {
  provider?: Provider;
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

function resolveConfigPath(): string {
  if (process.env.CLAWARTS_CONFIG) return path.resolve(process.env.CLAWARTS_CONFIG);
  const cwdPath = path.resolve("config.json");
  try {
    fs.accessSync(cwdPath, fs.constants.R_OK);
    return cwdPath;
  } catch {
    return clawHome("config.json");
  }
}

function loadConfigFile(): LegacyConfigFile {
  const configPath = resolveConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    if (isFileNotFound(err)) return {};
    throw err;
  }
  try {
    return JSON.parse(raw) as LegacyConfigFile;
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${errMsg(err)}`);
  }
}

export const AGENT_DEFAULTS: {
  provider: Provider;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  sessionTtlMinutes: number;
} = {
  provider: "openai-codex",
  model: "gpt-5.4",
  maxTokens: 8192,
  systemPrompt: "You are a helpful assistant in a Slack workspace.",
  sessionTtlMinutes: 120,
};

export const DEFAULT_MODELS: Record<Provider, string> = {
  "openai-codex": "gpt-5.4",
  "anthropic-claude": "claude-sonnet-4-20250514",
};

/** Resolve a value that may be a $ENV_VAR or ${ENV_VAR} reference. */
export function resolveEnvRef(value: string): string {
  let envName: string | undefined;
  if (value.startsWith("${") && value.endsWith("}")) {
    envName = value.slice(2, -1);
  } else if (value.startsWith("$")) {
    envName = value.slice(1);
  }
  if (envName) {
    const envValue = process.env[envName];
    if (!envValue) throw new Error(`Environment variable ${envName} is not set (referenced in config.json)`);
    return envValue;
  }
  return value;
}

const VALID_PROVIDERS: Set<Provider> = new Set(["openai-codex", "anthropic-claude"]);

function validateAgentConfig(config: AgentConfig): void {
  const errors: string[] = [];

  if (!config.id) errors.push("id is required");
  if (!VALID_PROVIDERS.has(config.provider)) {
    errors.push(`provider "${config.provider}" is not valid. Use: ${[...VALID_PROVIDERS].join(", ")}`);
  }
  if (!config.slackBotToken) errors.push("slackBotToken is required (or its $ENV_VAR must be set)");
  if (!config.slackAppToken) errors.push("slackAppToken is required (or its $ENV_VAR must be set)");
  if (config.maxTokens < 1) errors.push("maxTokens must be positive");
  if (config.maxTokens > 128_000) errors.push(`maxTokens (${config.maxTokens}) exceeds 128K — check your config`);
  if (config.sessionTtlMinutes < 1) errors.push("sessionTtlMinutes must be positive");
  if (config.thinkingBudgetTokens !== undefined && config.thinkingBudgetTokens < 0) {
    errors.push("thinkingBudgetTokens must be non-negative");
  }
  if (config.thinkingBudgetTokens && config.thinkingBudgetTokens >= config.maxTokens) {
    errors.push(`thinkingBudgetTokens (${config.thinkingBudgetTokens}) must be less than maxTokens (${config.maxTokens})`);
  }
  if (config.rateLimitPerMinute !== undefined && config.rateLimitPerMinute < 1) {
    errors.push("rateLimitPerMinute must be at least 1");
  }
  if (config.quietHours && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(config.quietHours)) {
    errors.push(`quietHours "${config.quietHours}" must be "HH:MM-HH:MM" format (e.g. "23:00-07:00")`);
  }
  if (config.quietHoursTimezone) {
    try {
      Intl.DateTimeFormat("en-US", { timeZone: config.quietHoursTimezone });
    } catch {
      errors.push(`quietHoursTimezone "${config.quietHoursTimezone}" is not a valid IANA timezone`);
    }
  }

  // Validate allowedUsers look like Slack user IDs
  if (config.allowedUsers) {
    for (const uid of config.allowedUsers) {
      if (!/^U[A-Z0-9]{8,12}$/.test(uid)) {
        log.warn(`${config.id}: allowedUsers entry "${uid}" doesn't look like a Slack user ID (expected U + 8-12 alphanumeric chars)`);
      }
    }
  }

  if (config.welcomeMessage && config.welcomeMessage.length > 2000) {
    errors.push(`welcomeMessage is too long (${config.welcomeMessage.length} chars, max 2000)`);
  }
  if (config.compactionThreshold !== undefined && config.compactionThreshold < 10_000) {
    errors.push(`compactionThreshold (${config.compactionThreshold}) is too low — minimum 10000`);
  }

  // Warn on suspicious model names (not an error — custom models exist)
  if (config.provider === "anthropic-claude" && !config.model.startsWith("claude-")) {
    log.warn(`${config.id}: model "${config.model}" doesn't look like a Claude model (expected "claude-*")`);
  }
  if (config.provider === "openai-codex" && !config.model.startsWith("codex-") && !config.model.startsWith("o") && !config.model.startsWith("gpt-")) {
    log.warn(`${config.id}: model "${config.model}" doesn't look like an OpenAI model`);
  }

  if (config.provider === "anthropic-claude" && !process.env.ANTHROPIC_API_KEY) {
    errors.push("ANTHROPIC_API_KEY environment variable is required for anthropic-claude provider");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid config for agent "${config.id}":\n  - ${errors.join("\n  - ")}`);
  }
}

/** Validate cross-agent references (linkedTutor, duplicate IDs). */
function validateCrossReferences(configs: AgentConfig[]): void {
  const ids = new Set<string>();
  const errors: string[] = [];
  for (const c of configs) {
    if (ids.has(c.id)) errors.push(`Duplicate agent ID: "${c.id}"`);
    ids.add(c.id);
  }
  for (const c of configs) {
    if (c.linkedTutor && !ids.has(c.linkedTutor)) {
      errors.push(`Agent "${c.id}" references linkedTutor "${c.linkedTutor}" which does not exist`);
    }
  }
  // Detect circular linkedTutor chains (A→B→A)
  for (const c of configs) {
    if (!c.linkedTutor) continue;
    const visited = new Set<string>();
    let current: string | undefined = c.id;
    while (current) {
      if (visited.has(current)) {
        errors.push(`Circular linkedTutor chain detected involving "${c.id}"`);
        break;
      }
      visited.add(current);
      current = configs.find((x) => x.id === current)?.linkedTutor;
    }
  }

  // Warn on overlapping allowedUsers across agents (same user assigned to multiple agents)
  const userToAgents = new Map<string, string[]>();
  for (const c of configs) {
    if (!c.allowedUsers) continue;
    for (const uid of c.allowedUsers) {
      const agents = userToAgents.get(uid) ?? [];
      agents.push(c.id);
      userToAgents.set(uid, agents);
    }
  }
  for (const [uid, agents] of userToAgents) {
    if (agents.length > 1) {
      log.warn(`User ${uid} is assigned to multiple agents: ${agents.join(", ")} — messages may route unpredictably`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Config validation errors:\n  - ${errors.join("\n  - ")}`);
  }
}

export function buildSkillSources(agentBase: string, workspaceDir: string): SkillSources {
  return {
    bundledDir: path.resolve("skills"),
    userGlobalDir: clawHome("skills"),
    agentDir: path.join(agentBase, "skills"),
    workspaceDir: path.join(workspaceDir, "skills"),
  };
}

function resolveAgentConfig(entry: AgentEntry, defaults: AgentDefaults, allEntries?: AgentEntry[]): AgentConfig {
  const agentBase = clawHome("agents", entry.id);

  // Resolve workspace: explicit > linked tutor nested > default
  let workspaceDir: string;
  if (entry.workspaceDir) {
    workspaceDir = expandTilde(entry.workspaceDir);
  } else if (entry.linkedTutor && allEntries) {
    const tutor = allEntries.find((e) => e.id === entry.linkedTutor);
    if (tutor) {
      const tutorBase = clawHome("agents", tutor.id);
      const tutorWorkspace = expandTilde(tutor.workspaceDir ?? defaults.workspaceDir ?? path.join(tutorBase, "workspace"));
      workspaceDir = path.join(tutorWorkspace, "students", entry.id);
    } else {
      workspaceDir = expandTilde(defaults.workspaceDir ?? path.join(agentBase, "workspace"));
    }
  } else {
    workspaceDir = expandTilde(defaults.workspaceDir ?? path.join(agentBase, "workspace"));
  }

  const defaultSkillsDirs = [path.join(workspaceDir, "skills")];

  return {
    id: entry.id,
    provider: entry.provider ?? defaults.provider ?? AGENT_DEFAULTS.provider,
    model: entry.model ?? defaults.model ?? DEFAULT_MODELS[entry.provider ?? defaults.provider ?? AGENT_DEFAULTS.provider] ?? AGENT_DEFAULTS.model,
    maxTokens: entry.maxTokens ?? defaults.maxTokens ?? AGENT_DEFAULTS.maxTokens,
    systemPrompt: entry.systemPrompt ?? defaults.systemPrompt ?? AGENT_DEFAULTS.systemPrompt,
    skillsDirs: (entry.skillsDirs ?? defaults.skillsDirs ?? defaultSkillsDirs).map(expandTilde),
    skillSources: entry.skillSources ?? defaults.skillSources ?? buildSkillSources(agentBase, workspaceDir),
    sessionTtlMinutes: entry.sessionTtlMinutes ?? defaults.sessionTtlMinutes ?? AGENT_DEFAULTS.sessionTtlMinutes,
    workspaceDir,
    slackBotToken: resolveEnvRef(entry.slackBotToken),
    slackAppToken: resolveEnvRef(entry.slackAppToken),
    allowedTools: entry.allowedTools ?? defaults.allowedTools,
    disallowedTools: entry.disallowedTools ?? defaults.disallowedTools,
    thinkingBudgetTokens: entry.thinkingBudgetTokens ?? defaults.thinkingBudgetTokens,
    linkedTutor: entry.linkedTutor,
    allowedUsers: entry.allowedUsers ?? defaults.allowedUsers,
    helpLevel: entry.helpLevel ?? defaults.helpLevel,
    maxToolIterations: entry.maxToolIterations ?? defaults.maxToolIterations,
    rateLimitPerMinute: entry.rateLimitPerMinute ?? defaults.rateLimitPerMinute,
    quietHours: entry.quietHours ?? defaults.quietHours,
    quietHoursTimezone: entry.quietHoursTimezone ?? defaults.quietHoursTimezone,
    compactionThreshold: entry.compactionThreshold ?? defaults.compactionThreshold,
    welcomeMessage: entry.welcomeMessage ?? defaults.welcomeMessage,
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

  log.info(`Config: ${resolveConfigPath()}`);

  // Multi-agent mode
  if (file.agents && file.agents.length > 0) {
    const defaults = file.defaults ?? {};
    const configs = file.agents.map((entry) => resolveAgentConfig(entry, defaults, file.agents));
    for (const config of configs) validateAgentConfig(config);
    validateCrossReferences(configs);
    // Warn on missing workspace or SOUL.md — helps professors catch setup issues early
    for (const config of configs) {
      if (!fs.existsSync(config.workspaceDir)) {
        log.warn(`${config.id}: workspaceDir "${config.workspaceDir}" does not exist — will be created on first use`);
      } else {
        const soulPath = path.join(config.workspaceDir, "SOUL.md");
        if (!fs.existsSync(soulPath)) {
          log.warn(`${config.id}: no SOUL.md found in workspace "${config.workspaceDir}" — agent will use generic persona`);
        }
      }
    }
    return configs;
  }

  // Legacy single-agent mode (Slack tokens from env)
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!botToken || !appToken) {
    throw new Error("Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN. Set them in .env or use multi-agent config.");
  }

  const agentBase = clawHome("agents", "default");
  const workspaceDir = expandTilde(file.workspaceDir ?? path.join(agentBase, "workspace"));
  const defaultSkillsDirs = [path.join(workspaceDir, "skills")];

  const config: AgentConfig = {
    id: "default",
    provider: file.provider ?? AGENT_DEFAULTS.provider,
    model: file.model ?? AGENT_DEFAULTS.model,
    maxTokens: file.maxTokens ?? AGENT_DEFAULTS.maxTokens,
    systemPrompt: file.systemPrompt ?? AGENT_DEFAULTS.systemPrompt,
    skillsDirs: (file.skillsDirs ?? defaultSkillsDirs).map(expandTilde),
    skillSources: buildSkillSources(agentBase, workspaceDir),
    sessionTtlMinutes: file.sessionTtlMinutes ?? AGENT_DEFAULTS.sessionTtlMinutes,
    workspaceDir,
    slackBotToken: botToken,
    slackAppToken: appToken,
  };
  validateAgentConfig(config);
  return [config];
}
