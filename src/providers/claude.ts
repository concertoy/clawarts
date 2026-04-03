import type { ToolDefinition } from "../types.js";
import type { ImageContent, ModelProvider, ProviderCallParams, ProviderMessage, ProviderResponse, ToolCall } from "../provider.js";
import { withRetry } from "../utils/retry.js";

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
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// ─── ClaudeProvider ───────────────────────────────────────────────────

export class ClaudeProvider implements ModelProvider {
  readonly name = "anthropic-claude";

  constructor(private apiKey: string) {}

  formatTools(tools: ToolDefinition[]): unknown {
    // Mark the last tool with cache_control so the entire tools array is cached.
    // Ported from claude-code's getCacheControl() — tools are static per session,
    // so caching them avoids re-processing on every turn.
    return tools.map((t, i) => {
      const base: Record<string, unknown> = {
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      };
      if (i === tools.length - 1) {
        base.cache_control = { type: "ephemeral" };
      }
      return base;
    });
  }

  async call(params: ProviderCallParams): Promise<ProviderResponse> {
    const useStreaming = !!params.onText;

    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens,
      // Use structured system prompt with cache_control for prompt caching.
      // Ported from claude-code's getCacheControl() — marks system prompt as ephemeral
      // so it's cached across turns within the same conversation.
      system: [
        {
          type: "text",
          text: params.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: formatClaudeMessages(params.messages),
      ...(useStreaming ? { stream: true } : {}),
    };

    const tools = params.tools as unknown[];
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    // Extended thinking support (ported from claude-code's thinking.ts)
    if (params.thinking?.budgetTokens && params.thinking.budgetTokens > 0) {
      const budgetTokens = Math.min(params.maxTokens - 1, params.thinking.budgetTokens);
      body.thinking = {
        type: "enabled",
        budget_tokens: budgetTokens,
      };
    }

    return withRetry(
      async () => {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            // Beta headers for extended thinking + interleaved content.
            // Ported from claude-code's getAnthropicHeaders() pattern.
            ...(params.thinking?.budgetTokens
              ? { "anthropic-beta": "interleaved-thinking-2025-05-14" }
              : {}),
          },
          body: JSON.stringify(body),
          signal: params.signal,
        });

        if (!resp.ok) {
          const text = await resp.text();
          // Include request ID for debugging — ported from claude-code's error handling
          const requestId = resp.headers.get("request-id") ?? "unknown";
          throw new Error(`Anthropic API error (${resp.status}, req=${requestId}): ${text}`);
        }

        if (useStreaming) {
          return this.consumeStream(resp, params.onText!);
        }

        const result = (await resp.json()) as AnthropicResponse;
        return parseClaudeResponse(result);
      },
      { maxRetries: 5 },
    );
  }

  /**
   * Consume an SSE stream from the Anthropic Messages API.
   * Ported from claude-code's streaming pattern (claude.ts queryModel).
   * Fires onText for each text delta so callers can update Slack messages progressively.
   */
  private async consumeStream(
    resp: Response,
    onText: (delta: string) => void,
  ): Promise<ProviderResponse> {
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    let stopReason: ProviderResponse["stopReason"] = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;

    // Track current content blocks being streamed
    const activeBlocks = new Map<number, { type: string; id?: string; name?: string; inputJson: string }>();

    let buffer = "";

    try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE frames: "event: <type>\ndata: <json>\n\n"
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? ""; // keep incomplete frame in buffer

      for (const frame of frames) {
        const lines = frame.split("\n");
        let eventType = "";
        const dataParts: string[] = [];

        for (const line of lines) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataParts.push(line.slice(6));
          else if (line === ":") continue; // SSE comment/keepalive
        }

        const data = dataParts.join("");
        if (!data || !eventType) continue;

        try {
          const parsed = JSON.parse(data);

          switch (eventType) {
            case "content_block_start": {
              const idx = parsed.index as number;
              const block = parsed.content_block as AnthropicContentBlock;
              if (block.type === "tool_use") {
                activeBlocks.set(idx, { type: "tool_use", id: block.id, name: block.name, inputJson: "" });
              } else if (block.type === "thinking" || block.type === "redacted_thinking") {
                // Extended thinking blocks — track but don't stream to user.
                // redacted_thinking blocks appear when thinking content is filtered.
                activeBlocks.set(idx, { type: "thinking", inputJson: "" });
              } else if (block.type === "text") {
                activeBlocks.set(idx, { type: "text", inputJson: "" });
                if (block.text) {
                  textParts.push(block.text);
                  onText(block.text);
                }
              }
              break;
            }

            case "content_block_delta": {
              const idx = parsed.index as number;
              const delta = parsed.delta;
              const active = activeBlocks.get(idx);

              if (delta?.type === "text_delta" && delta.text) {
                textParts.push(delta.text);
                onText(delta.text);
              } else if (delta?.type === "thinking_delta" && active?.type === "thinking") {
                // Accumulate thinking but don't stream it to the user
                active.inputJson += delta.thinking ?? "";
              } else if (delta?.type === "input_json_delta" && delta.partial_json && active) {
                active.inputJson += delta.partial_json;
              }
              break;
            }

            case "content_block_stop": {
              const idx = parsed.index as number;
              const active = activeBlocks.get(idx);
              if (active?.type === "tool_use") {
                toolCalls.push({
                  id: active.id ?? "",
                  name: active.name ?? "",
                  arguments: active.inputJson || "{}",
                });
              }
              activeBlocks.delete(idx);
              break;
            }

            case "message_start": {
              // Anthropic sends input token count + cache stats in message_start.
              // Ported from claude-code's streaming token tracking.
              const msgUsage = parsed.message?.usage;
              if (msgUsage) {
                if (msgUsage.input_tokens) inputTokens = msgUsage.input_tokens;
                if (msgUsage.cache_read_input_tokens) cacheReadTokens = msgUsage.cache_read_input_tokens;
                if (msgUsage.cache_creation_input_tokens) cacheCreationTokens = msgUsage.cache_creation_input_tokens;
              }
              break;
            }

            case "message_delta": {
              if (parsed.delta?.stop_reason) {
                const sr = parsed.delta.stop_reason;
                if (sr === "tool_use") stopReason = "tool_use";
                else if (sr === "max_tokens") stopReason = "max_tokens";
                else stopReason = "end_turn";
              }
              // Anthropic sends output token count in message_delta
              if (parsed.usage?.output_tokens) {
                outputTokens = parsed.usage.output_tokens;
              }
              break;
            }
          }
        } catch {
          // Skip malformed SSE data
        }
      }
    }
    } finally {
      // Release the reader to prevent connection leaks.
      // Ported from claude-code's stream cleanup pattern.
      reader.releaseLock();
    }

    return {
      text: textParts.join(""),
      toolCalls,
      stopReason,
      usage: inputTokens || outputTokens
        ? {
            inputTokens,
            outputTokens,
            cacheReadTokens: cacheReadTokens || undefined,
            cacheCreationTokens: cacheCreationTokens || undefined,
          }
        : undefined,
      raw: null,
    };
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
      // Support multi-modal messages with images (ported from claude-code attachment handling)
      if (msg.images && msg.images.length > 0) {
        const content: unknown[] = [];
        for (const img of msg.images) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mediaType,
              data: img.base64,
            },
          });
        }
        content.push({ type: "text", text: msg.content });
        out.push({ role: "user", content });
      } else {
        out.push({ role: "user", content: msg.content });
      }
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
      const block: Record<string, unknown> = {
        type: "tool_result",
        tool_use_id: msg.callId,
        content: msg.output,
      };
      // Signal tool failure to the model — ported from claude-code's is_error pattern.
      // This helps Claude adjust its approach rather than repeating the same failed call.
      if (msg.isError) block.is_error = true;
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }

  // Place cache_control breakpoint on the last user message's last content block.
  // This is claude-code's key prompt caching optimization — it creates a cache
  // breakpoint so that system prompt + tools + full conversation history up to the
  // latest user turn is cached, dramatically reducing input token costs on multi-turn.
  // Ported from claude-code's getCacheControl() → applyCachePoints() pattern.
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "user") {
      const content = out[i].content;
      if (typeof content === "string") {
        // Convert to content block array so we can attach cache_control
        out[i].content = [{ type: "text", text: content, cache_control: { type: "ephemeral" } }];
      } else if (Array.isArray(content) && content.length > 0) {
        // Attach cache_control to the last content block
        const lastBlock = content[content.length - 1] as Record<string, unknown>;
        lastBlock.cache_control = { type: "ephemeral" };
      }
      break;
    }
  }

  return out;
}

// ─── Response parsing ─────────────────────────────────────────────────

function parseClaudeResponse(result: AnthropicResponse): ProviderResponse {
  const toolCalls: ToolCall[] = [];
  const textParts: string[] = [];

  for (const block of result.content) {
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      // Extended/redacted thinking blocks — not included in response text
      continue;
    } else if (block.type === "text" && block.text) {
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
    usage: result.usage
      ? {
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          cacheReadTokens: result.usage.cache_read_input_tokens,
          cacheCreationTokens: result.usage.cache_creation_input_tokens,
        }
      : undefined,
    raw: result,
  };
}
