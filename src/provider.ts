import type { ToolDefinition } from "./types.js";

// ─── Unified types ────────────────────────────────────────────────────

/** Normalized tool call — common representation across providers. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON-encoded
}

/** Unified response from any LLM provider. */
export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "error";
  raw: unknown;
}

/** Conversation message types used by the provider abstraction. */
export type ProviderMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool_result"; callId: string; name: string; output: string };

/** Parameters for a provider API call. */
export interface ProviderCallParams {
  model: string;
  systemPrompt: string;
  messages: ProviderMessage[];
  tools: unknown; // Provider-specific formatted tools
  maxTokens: number;
  signal?: AbortSignal;
}

// ─── ModelProvider interface ──────────────────────────────────────────

export interface ModelProvider {
  readonly name: string;

  /** Convert ToolDefinitions into the provider's native tool schema format. */
  formatTools(tools: ToolDefinition[]): unknown;

  /** Make an LLM API call, return a normalized response. */
  call(params: ProviderCallParams): Promise<ProviderResponse>;
}
