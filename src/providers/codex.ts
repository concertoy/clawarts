import os from "node:os";
import type { ToolDefinition } from "../types.js";
import type { TokenProvider } from "../auth.js";
import type { ModelProvider, ProviderCallParams, ProviderMessage, ProviderResponse, ToolCall } from "../provider.js";
import { withRetry } from "../utils/retry.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex/responses";

// ─── Codex API types ──────────────────────────────────────────────────

interface CodexResponseItem {
  type: string;
  id?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  role?: string;
  content?: { type: string; text?: string }[];
  status?: string;
}

interface CodexResponse {
  id: string;
  output: CodexResponseItem[];
  status: string;
}

// ─── CodexProvider ────────────────────────────────────────────────────

export class CodexProvider implements ModelProvider {
  readonly name = "openai-codex";

  constructor(private tokenProvider: TokenProvider) {}

  formatTools(tools: ToolDefinition[]): unknown {
    return tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }));
  }

  async call(params: ProviderCallParams): Promise<ProviderResponse> {
    return withRetry(
      async () => {
        const token = await this.tokenProvider.getToken();
        const accountId = this.tokenProvider.getAccountIdSync();

        const input = formatCodexMessages(params.messages);
        const userAgent = `clawarts (${os.platform()} ${os.release()}; ${os.arch()})`;

        const resp = await fetch(CODEX_BASE_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "chatgpt-account-id": accountId,
            "originator": "clawarts",
            "OpenAI-Beta": "responses=experimental",
            "accept": "text/event-stream",
            "Content-Type": "application/json",
            "User-Agent": userAgent,
          },
          body: JSON.stringify({
            model: params.model,
            instructions: params.systemPrompt,
            input,
            tools: params.tools,
            stream: true,
            store: false,
          }),
          signal: params.signal,
        });

        if (!resp.ok) {
          const text = await resp.text();
          const requestId = resp.headers.get("x-request-id") ?? "unknown";
          throw new Error(`Codex API error (${resp.status}, req=${requestId}): ${text}`);
        }

        // If onText callback is provided, stream incrementally for progressive updates
        if (params.onText && resp.body) {
          return this.consumeStream(resp, params.onText);
        }

        // Non-streaming: read full response
        const text = await resp.text();
        let result: CodexResponse | null = null;

        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;
          try {
            const event = JSON.parse(data);
            if (event.type === "response.completed" && event.response) {
              result = event.response as CodexResponse;
            }
          } catch {
            // skip malformed SSE lines
          }
        }

        if (!result) throw new Error("No response.completed event from Codex API");
        return parseCodexResponse(result);
      },
      { maxRetries: 5 },
    );
  }

  /**
   * Consume Codex SSE stream incrementally, firing onText for text deltas.
   * Codex SSE events include:
   *   response.output_text.delta — incremental text
   *   response.function_call_arguments.delta — tool call args
   *   response.completed — final complete response
   */
  private async consumeStream(
    resp: Response,
    onText: (delta: string) => void,
  ): Promise<ProviderResponse> {
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();

    let result: CodexResponse | null = null;
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush any remaining multi-byte UTF-8 bytes from the decoder
          buffer += decoder.decode(undefined, { stream: false });
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const event = JSON.parse(data);

            if (event.type === "response.output_text.delta" && event.delta) {
              onText(event.delta);
            } else if (event.type === "response.completed" && event.response) {
              result = event.response as CodexResponse;
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!result) throw new Error("No response.completed event from Codex API");
    return parseCodexResponse(result);
  }
}

// ─── Message formatting ───────────────────────────────────────────────

function formatCodexMessages(messages: ProviderMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      let content = msg.content;
      if (msg.images && msg.images.length > 0) {
        content = `[Note: ${msg.images.length} image(s) attached but not supported by this provider — describe what you see instead.]\n${content}`;
      }
      out.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        // Emit function_call items for each tool call
        for (const tc of msg.toolCalls) {
          out.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: tc.arguments });
        }
        // Also emit the text portion if present
        if (msg.content) {
          out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: msg.content }] });
        }
      } else {
        out.push({ role: "assistant", content: msg.content });
      }
    } else if (msg.role === "tool_result") {
      const output = msg.isError ? `[Error] ${msg.output}` : msg.output;
      out.push({ type: "function_call_output", call_id: msg.callId, output });
    }
  }
  return out;
}

// ─── Response parsing ─────────────────────────────────────────────────

function parseCodexResponse(result: CodexResponse): ProviderResponse {
  const toolCalls: ToolCall[] = [];
  const textParts: string[] = [];

  for (const item of result.output) {
    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id ?? "",
        name: item.name ?? "",
        arguments: item.arguments ?? "{}",
      });
    } else if (item.type === "message" && item.role === "assistant") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text" && c.text) textParts.push(c.text);
      }
    }
  }

  const hasToolCalls = toolCalls.length > 0;
  return {
    text: textParts.join(""),
    toolCalls,
    stopReason: hasToolCalls ? "tool_use" : "end_turn",
    raw: result,
  };
}
