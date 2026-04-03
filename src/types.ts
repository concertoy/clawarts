export type Provider = "openai-codex" | "anthropic-claude";

/** Per-agent configuration (resolved from defaults + agent overrides). */
export interface AgentConfig {
  id: string;
  provider: Provider;
  model: string;
  maxTokens: number;
  skillsDirs: string[];
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
}

/** Top-level config file shape. */
export interface RootConfig {
  defaults: AgentDefaults;
  agents: AgentEntry[];
}

export interface AgentDefaults {
  provider?: string;
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  skillsDirs?: string[];
  sessionTtlMinutes?: number;
  workspaceDir?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  thinkingBudgetTokens?: number;
}

export interface AgentEntry {
  id: string;
  slackBotToken: string;
  slackAppToken: string;
  provider?: string;
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  skillsDirs?: string[];
  sessionTtlMinutes?: number;
  workspaceDir?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  thinkingBudgetTokens?: number;
}

export interface WorkspaceFile {
  name: string;
  content: string;
}

export interface Skill {
  name: string;
  description: string;
  filePath: string;
}

export interface ConversationMessage {
  role: string;
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
export type ToolCategory = "filesystem" | "shell" | "search" | "web" | "scheduling" | "utility";

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
