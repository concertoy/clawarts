export type Provider = "openai-codex" | "anthropic-claude";

/** How much help the student agent provides. */
export type HelpLevel = "hints" | "guided" | "full";

/** Per-agent configuration (resolved from defaults + agent overrides). */
export interface AgentConfig {
  id: string;
  provider: Provider;
  model: string;
  maxTokens: number;
  skillsDirs: string[];
  skillSources?: SkillSources;
  sessionTtlMinutes: number;
  systemPrompt: string;
  workspaceDir: string;
  slackBotToken: string;
  slackAppToken: string;
  /** If set, only these tools are available to this agent (allowlist). */
  allowedTools?: string[];
  /** If set, these tools are removed from this agent (denylist). Applied after allowedTools. */
  disallowedTools?: string[];
  /** Extended thinking budget in tokens. Set > 0 to enable Claude's thinking/reasoning. */
  thinkingBudgetTokens?: number;
  /** For student agents: ID of the tutor agent whose workspace contains this student's workspace. */
  linkedTutor?: string;
  /** If set, only these Slack user IDs can interact with this agent. Others are silently ignored. */
  allowedUsers?: string[];
  /** How much help the agent provides. "hints" = questions only, "guided" = explain approach (default), "full" = no restriction. */
  helpLevel?: HelpLevel;
  /** Max tool execution iterations per reply. Higher = more complex tasks, more API cost. Default: 10. */
  maxToolIterations?: number;
  /** Max agent replies per minute. Prevents runaway API costs. Default: 30. */
  rateLimitPerMinute?: number;
}

/** Top-level config file shape. */
export interface RootConfig {
  defaults: AgentDefaults;
  agents: AgentEntry[];
}

/** Fields shared between defaults and per-agent overrides. */
type AgentOverrides = Partial<Pick<AgentConfig,
  | "provider" | "model" | "maxTokens" | "systemPrompt"
  | "skillsDirs" | "skillSources" | "sessionTtlMinutes" | "workspaceDir"
  | "allowedTools" | "disallowedTools" | "thinkingBudgetTokens"
  | "allowedUsers" | "helpLevel" | "maxToolIterations" | "rateLimitPerMinute"
>>;

export interface AgentDefaults extends AgentOverrides {}

export interface AgentEntry extends AgentOverrides {
  id: string;
  slackBotToken: string;
  slackAppToken: string;
  /** For student agents: ID of the tutor agent whose workspace contains this student's workspace. */
  linkedTutor?: string;
}

export interface WorkspaceFile {
  name: string;
  content: string;
}

export type SkillSource = "bundled" | "user-global" | "agent" | "workspace" | "legacy";

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  source?: SkillSource;
  allowedTools?: string[];
  whenToUse?: string;
  arguments?: string;
}

/** Directories for multi-source skill loading with precedence. */
export interface SkillSources {
  bundledDir?: string;
  userGlobalDir?: string;
  agentDir?: string;
  workspaceDir?: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationSession {
  key: string;
  messages: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Context passed to every tool execution.
 * Ported from claude-code's ToolUseContext — provides conversation metadata
 * so tools can act on the current channel/user without LLM supplying it.
 */
export interface ToolUseContext {
  agentId: string;
  channelId: string;
  userId: string;
  threadTs?: string;
  sessionKey: string;
}

/** Tool categories for grouping and bulk filtering. */
export type ToolCategory = "filesystem" | "shell" | "search" | "web" | "scheduling" | "utility" | "academic" | "communication";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (input: Record<string, unknown>, context?: ToolUseContext) => Promise<string>;
  /** If true, this tool only reads state and never mutates it. */
  isReadOnly?: boolean;
  /** Tool category for grouping and bulk allow/deny. */
  category?: ToolCategory;
  /** Runtime gate — if returns false, tool is excluded. Ported from claude-code Tool.isEnabled(). */
  isEnabled?: () => boolean;
}
