import type { AgentConfig, Skill, ToolDefinition, WorkspaceFile } from "./types.js";
import type { ModelProvider, ProviderMessage, ToolCall } from "./provider.js";
import { SessionStore } from "./session.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { runToolBatch } from "./tool-runner.js";

const MAX_TOOL_ITERATIONS = 10;

// ─── Agent ──────────────────────────────────────────────────────────────

export class Agent {
  private systemPrompt: string;
  private toolDefs: ToolDefinition[];

  constructor(
    private config: AgentConfig,
    private provider: ModelProvider,
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
    const session = this.sessions.get(sessionKey);
    const formattedTools = this.provider.formatTools(this.toolDefs);

    // Build conversation messages from session history + new user message
    const userContent = `[From: <@${userId}>]\n${userMessage}`;
    const messages: ProviderMessage[] = [
      ...session.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user" as const, content: userContent },
    ];

    session.messages.push({ role: "user", content: userContent });

    // ─── Agent loop (while-true, borrowed from claude-code queryLoop) ───

    let lastText = "";
    let iteration = 0;

    while (true) {
      const response = await this.provider.call({
        model: this.config.model,
        systemPrompt: this.systemPrompt,
        messages,
        tools: formattedTools,
        maxTokens: this.config.maxTokens,
      });

      lastText = response.text;

      // Exit: no tool calls or model chose to stop
      if (response.toolCalls.length === 0 || response.stopReason !== "tool_use") {
        break;
      }

      // Safety limit
      if (++iteration >= MAX_TOOL_ITERATIONS) {
        console.log(`[agent] Hit max tool iterations (${MAX_TOOL_ITERATIONS})`);
        break;
      }

      // Append assistant message (with tool calls) to conversation
      messages.push({
        role: "assistant",
        content: response.text,
        toolCalls: response.toolCalls,
      });

      // Execute tools — concurrent for read-only, serial for writes
      const results = await runToolBatch(this.toolDefs, response.toolCalls);

      // Append tool results to conversation
      for (const result of results) {
        messages.push({
          role: "tool_result",
          callId: result.callId,
          name: result.name,
          output: result.output,
        });
        console.log(`[agent] Tool ${result.name} executed`);
      }
    }

    const reply = lastText || "[No response]";
    session.messages.push({ role: "assistant", content: reply });
    this.sessions.truncate(session);
    return reply;
  }
}
