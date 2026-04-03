import type { ToolDefinition } from "../types.js";
import type { ModelProvider, ProviderCallParams, ProviderMessage, ProviderResponse, ToolCall } from "../provider.js";

// ─── Anthropic API types ──────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  id: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

// ─── ClaudeProvider ───────────────────────────────────────────────────

export class ClaudeProvider implements ModelProvider {
  readonly name = "anthropic-claude";

  constructor(private apiKey: string) {}

  formatTools(tools: ToolDefinition[]): unknown {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  async call(params: ProviderCallParams): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.systemPrompt,
      messages: formatClaudeMessages(params.messages),
    };

    const tools = params.tools as unknown[];
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic API error (${resp.status}): ${text}`);
    }

    const result = (await resp.json()) as AnthropicResponse;
    return parseClaudeResponse(result);
  }
}

// ─── Message formatting ───────────────────────────────────────────────

interface ClaudeMessage {
  role: string;
  content: unknown;
}

function formatClaudeMessages(messages: ProviderMessage[]): ClaudeMessage[] {
  const out: ClaudeMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const content: unknown[] = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: JSON.parse(tc.arguments),
          });
        }
      }
      out.push({ role: "assistant", content: content.length === 1 ? content[0] : content });
    } else if (msg.role === "tool_result") {
      // Anthropic tool results are sent as user messages with tool_result content blocks.
      // Merge consecutive tool_result messages into a single user message.
      const last = out[out.length - 1];
      const block = {
        type: "tool_result",
        tool_use_id: msg.callId,
        content: msg.output,
      };
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }

  return out;
}

// ─── Response parsing ─────────────────────────────────────────────────

function parseClaudeResponse(result: AnthropicResponse): ProviderResponse {
  const toolCalls: ToolCall[] = [];
  const textParts: string[] = [];

  for (const block of result.content) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        name: block.name ?? "",
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }

  let stopReason: ProviderResponse["stopReason"];
  if (result.stop_reason === "tool_use") {
    stopReason = "tool_use";
  } else if (result.stop_reason === "max_tokens") {
    stopReason = "max_tokens";
  } else {
    stopReason = "end_turn";
  }

  return {
    text: textParts.join("\n"),
    toolCalls,
    stopReason,
    raw: result,
  };
}
