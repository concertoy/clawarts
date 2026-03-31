import type { AgentConfig, Skill, ToolDefinition, WorkspaceFile } from "./types.js";
import type { TokenProvider } from "./auth.js";
import { SessionStore } from "./session.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { executeTool } from "./tools.js";
import os from "node:os";

const MAX_TOOL_ITERATIONS = 10;

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex/responses";

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

// ─── Agent ──────────────────────────────────────────────────────────────

export class Agent {
  private systemPrompt: string;
  private toolDefs: ToolDefinition[];

  constructor(
    private config: AgentConfig,
    private tokenProvider: TokenProvider,
    private sessions: SessionStore,
    skills: Skill[],
    tools: ToolDefinition[],
    workspaceFiles: WorkspaceFile[],
  ) {
    this.systemPrompt = buildSystemPrompt({
      identity: config.systemPrompt,
      skills,
      workspaceFiles,
    });
    this.toolDefs = tools;
  }

  async getReply(sessionKey: string, userMessage: string, userId: string): Promise<string> {
    return this.getReplyCodex(sessionKey, userMessage, userId);
  }

  private getCodexToolSchemas() {
    return this.toolDefs.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }));
  }

  private async getReplyCodex(sessionKey: string, userMessage: string, userId: string): Promise<string> {
    const session = this.sessions.get(sessionKey);
    const token = await this.tokenProvider.getToken();
    const accountId = this.tokenProvider.getAccountIdSync();
    const toolSchemas = this.getCodexToolSchemas();

    const input: any[] = [
      ...session.messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: `[From: <@${userId}>]\n${userMessage}` },
    ];

    session.messages.push({ role: "user", content: `[From: <@${userId}>]\n${userMessage}` });

    let response = await this.callCodex(token, accountId, {
      model: this.config.model,
      instructions: this.systemPrompt,
      input,
      tools: toolSchemas,
    });

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const functionCalls = response.output.filter((item) => item.type === "function_call");
      if (functionCalls.length === 0) break;

      // Append assistant output (function_call items) to conversation
      for (const item of response.output) {
        input.push(item);
      }

      // Execute tools and append results to conversation
      for (const call of functionCalls) {
        const args = JSON.parse(call.arguments ?? "{}") as Record<string, unknown>;
        const result = await executeTool(this.toolDefs, call.name ?? "", args);
        console.log(`[agent] Tool ${call.name} executed`);
        input.push({ type: "function_call_output", call_id: call.call_id ?? "", output: result });
      }

      response = await this.callCodex(token, accountId, {
        model: this.config.model,
        instructions: this.systemPrompt,
        input,
        tools: toolSchemas,
      });
    }

    const textParts = response.output
      .filter((item) => item.type === "message" && item.role === "assistant")
      .flatMap((msg) =>
        (msg.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? ""),
      );

    const reply = textParts.join("\n") || "[No response]";
    session.messages.push({ role: "assistant", content: reply });
    this.sessions.truncate(session);
    return reply;
  }

  private async callCodex(
    token: string,
    accountId: string,
    body: Record<string, unknown>,
  ): Promise<CodexResponse> {
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
      body: JSON.stringify({ ...body, stream: true, store: false }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Codex API error (${resp.status}): ${text}`);
    }

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
        // skip
      }
    }

    if (!result) throw new Error("No response.completed event from Codex API");
    return result;
  }
}
