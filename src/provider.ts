import type { ToolDefinition } from "./types.js";

// ─── Unified types ────────────────────────────────────────────────────

/** Normalized tool call — common representation across providers. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON-encoded
}

/** Token usage from an API call. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Unified response from any LLM provider. */
export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "error";
  usage?: TokenUsage;
  raw: unknown;
}

/** Image content for multi-modal messages. Ported from claude-code's attachment handling. */
export interface ImageContent {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  base64: string;
}

/** Conversation message types used by the provider abstraction. */
export type ProviderMessage =
  | { role: "user"; content: string; images?: ImageContent[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool_result"; callId: string; name: string; output: string; isError?: boolean };

/** Extended thinking configuration. Ported from claude-code's ThinkingConfig. */
export interface ThinkingConfig {
  /** Thinking budget in tokens. Set to 0 or omit to disable. */
  budgetTokens?: number;
}

/** Parameters for a provider API call. */
export interface ProviderCallParams {
  model: string;
  systemPrompt: string;
  messages: ProviderMessage[];
  tools: unknown; // Provider-specific formatted tools
  maxTokens: number;
  signal?: AbortSignal;
  /** If provided, stream text deltas to this callback as they arrive. */
  onText?: (delta: string) => void;
  /** Extended thinking configuration. Provider-specific — currently only Claude. */
  thinking?: ThinkingConfig;
}

// ─── ModelProvider interface ──────────────────────────────────────────

export interface ModelProvider {
  readonly name: string;

  /** Convert ToolDefinitions into the provider's native tool schema format. */
  formatTools(tools: ToolDefinition[]): unknown;

  /** Make an LLM API call, return a normalized response. */
  call(params: ProviderCallParams): Promise<ProviderResponse>;
}
