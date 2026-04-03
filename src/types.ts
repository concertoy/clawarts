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

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
  /** If true, this tool only reads state and never mutates it. */
  isReadOnly?: boolean;
}
