import type { AgentConfig, Skill, ToolDefinition, ToolUseContext, WorkspaceFile } from "./types.js";
import type { ImageContent, ModelProvider, ProviderMessage, ToolCall } from "./provider.js";
import { SessionStore } from "./session.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { runToolBatch } from "./tool-runner.js";

const MAX_TOOL_ITERATIONS = 10;

/**
 * Estimated character threshold for triggering compaction.
 * ~80K chars ≈ 20K tokens — leaves headroom for the model's context window.
 * Ported from claude-code's autoCompact threshold logic (simplified).
 */
const COMPACTION_CHAR_THRESHOLD = 80_000;

// ─── Agent ──────────────────────────────────────────────────────────────

export class Agent {
  private systemPrompt: string;
  private toolDefs: ToolDefinition[];

  /**
   * Track in-flight AbortControllers per session.
   * When a new message arrives for a session that already has an active request,
   * the old request is canceled to prevent stale responses.
   * Ported from claude-code's abortController pattern.
   */
  private activeRequests = new Map<string, AbortController>();

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
      tools,
      helpLevel: config.helpLevel,
    });
    this.toolDefs = tools;
  }

  async getReply(
    sessionKey: string,
    userMessage: string,
    userId: string,
    context?: { channelId?: string; threadTs?: string },
    onText?: (delta: string) => void,
    images?: ImageContent[],
  ): Promise<string> {
    // Cancel any in-flight request for this session (ported from claude-code abortController)
    const existingController = this.activeRequests.get(sessionKey);
    if (existingController) {
      existingController.abort();
      console.log(`[agent] Canceled in-flight request for session ${sessionKey}`);
    }
    const abortController = new AbortController();
    this.activeRequests.set(sessionKey, abortController);

    const session = this.sessions.get(sessionKey);
    const formattedTools = this.provider.formatTools(this.toolDefs);

    // Inject conversation context into the system prompt (ported from claude-code's userContext injection)
    const contextParts: string[] = [];
    if (context?.channelId) {
      contextParts.push(`Current Slack channel: ${context.channelId}${context.threadTs ? ` (thread: ${context.threadTs})` : ""}`);
    }
    contextParts.push(`Current user: <@${userId}>`);
    contextParts.push(`Current time: ${new Date().toISOString()}`);
    const systemPromptWithContext = this.systemPrompt + "\n" + contextParts.join("\n");

    // Build conversation messages from session history + new user message
    const userContent = `[From: <@${userId}>]\n${userMessage}`;
    const messages: ProviderMessage[] = [
      ...session.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user" as const, content: userContent, ...(images?.length ? { images } : {}) },
    ];

    // Ensure valid role alternation for Claude API (user→assistant→user→...).
    // Ported from claude-code's ensureAlternatingRoles() pattern.
    ensureAlternatingRoles(messages);

    session.messages.push({ role: "user", content: userContent });

    // ─── Agent loop (while-true, borrowed from claude-code queryLoop) ───

    let lastText = "";
    let turnCount = 0;
    let maxTokensRecoveryCount = 0;
    const MAX_TOKEN_RECOVERIES = 2;

    const agentStartMs = Date.now();

    // Token usage tracking (ported from claude-code cost-tracker)
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;

    // Build tool execution context once (ported from claude-code ToolUseContext)
    const toolContext: ToolUseContext = {
      agentId: this.config.id,
      channelId: context?.channelId ?? "",
      userId,
      threadTs: context?.threadTs,
      sessionKey,
    };

    try {
      while (true) {
        turnCount++;

        // Compact conversation if it's getting too large (ported from claude-code autoCompact)
        await this.compactIfNeeded(messages, systemPromptWithContext, sessionKey);

        // Check if aborted before making API call
        if (abortController.signal.aborted) {
          console.log(`[agent] Request aborted before turn ${turnCount}`);
          break;
        }

        const response = await this.provider.call({
          model: this.config.model,
          systemPrompt: systemPromptWithContext,
          messages,
          tools: formattedTools,
          maxTokens: this.config.maxTokens,
          onText,
          signal: abortController.signal,
          thinking: this.config.thinkingBudgetTokens
            ? { budgetTokens: this.config.thinkingBudgetTokens }
            : undefined,
        });

        lastText = response.text;

        // Track token usage
        if (response.usage) {
          totalInputTokens += response.usage.inputTokens;
          totalOutputTokens += response.usage.outputTokens;
          totalCacheReadTokens += response.usage.cacheReadTokens ?? 0;
          totalCacheCreationTokens += response.usage.cacheCreationTokens ?? 0;
        }

        // Handle max_tokens — model was cut off mid-response.
        // Ported from claude-code queryLoop: append partial response and ask to continue.
        if (response.stopReason === "max_tokens" && maxTokensRecoveryCount < MAX_TOKEN_RECOVERIES) {
          maxTokensRecoveryCount++;
          console.log(`[agent] max_tokens hit (recovery ${maxTokensRecoveryCount}/${MAX_TOKEN_RECOVERIES}), continuing`);
          // Drop tool calls from truncated responses — they likely have incomplete JSON
          // arguments and would create dangling tool_use blocks without matching tool_result.
          // Ported from claude-code's max_tokens recovery that only preserves text.
          const validToolCalls = response.toolCalls.filter((tc) => {
            try { JSON.parse(tc.arguments); return true; } catch { return false; }
          });
          if (validToolCalls.length > 0) {
            // Some tool calls have valid JSON — execute them before continuing
            messages.push({ role: "assistant", content: response.text, toolCalls: validToolCalls });
            const results = await runToolBatch(this.toolDefs, validToolCalls, toolContext);
            for (const result of results) {
              messages.push({ role: "tool_result", callId: result.callId, name: result.name, output: result.output, isError: result.isError });
            }
          } else {
            // No valid tool calls — just push the text and ask to continue
            messages.push({ role: "assistant", content: response.text || "[Response truncated]" });
          }
          messages.push({ role: "user", content: "[System: Your response was truncated. Please continue where you left off.]" });
          continue;
        }

        // Exit: no tool calls or model chose to stop
        if (response.toolCalls.length === 0 || response.stopReason !== "tool_use") {
          break;
        }

        // Safety limit
        if (turnCount >= MAX_TOOL_ITERATIONS) {
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
        const results = await runToolBatch(this.toolDefs, response.toolCalls, toolContext);

        // Append tool results to conversation
        for (const result of results) {
          messages.push({
            role: "tool_result",
            callId: result.callId,
            name: result.name,
            output: result.output,
            isError: result.isError,
          });
        }

        console.log(`[agent] Turn ${turnCount}: ${results.map((r) => r.name).join(", ")}`);
      }
    } catch (err) {
      // Re-throw abort errors (handled by caller in slack.ts)
      if (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"))) {
        throw err;
      }
      // Log unexpected errors but still save partial response
      console.error(`[agent] Error in agent loop (turn ${turnCount}):`, err);
      if (!lastText) {
        lastText = "[An error occurred while processing your request. Please try again.]";
      }
    } finally {
      // Always clean up abort controller — prevents memory leaks
      this.activeRequests.delete(sessionKey);
    }

    const elapsedSec = ((Date.now() - agentStartMs) / 1000).toFixed(1);
    const cacheInfo = totalCacheReadTokens > 0 ? `, cache: ${totalCacheReadTokens} read / ${totalCacheCreationTokens} created` : "";
    console.log(`[agent] Complete: ${turnCount} turns in ${elapsedSec}s, ${totalInputTokens} input + ${totalOutputTokens} output tokens${cacheInfo}`);

    const reply = lastText || "[No response]";
    session.messages.push({ role: "assistant", content: reply });
    this.sessions.truncate(session);
    this.sessions.persistSession(sessionKey);
    return reply;
  }

  /**
   * Lightweight conversation compaction.
   * When total message characters exceed the threshold, ask the model to summarize
   * older messages and replace them with a compact summary.
   * Ported from claude-code's autoCompact (simplified — no token counting, uses char estimate).
   */
  private async compactIfNeeded(
    messages: ProviderMessage[],
    systemPrompt: string,
    sessionKey?: string,
  ): Promise<void> {
    const totalChars = messages.reduce((sum, m) => {
      let size = m.role === "tool_result" ? m.output.length : m.content.length;
      if (m.role === "assistant" && m.toolCalls) {
        size += m.toolCalls.reduce((s, tc) => s + tc.arguments.length, 0);
      }
      return sum + size;
    }, 0);

    if (totalChars < COMPACTION_CHAR_THRESHOLD || messages.length < 6) return;

    // Keep the last few messages intact, summarize the rest
    const keepCount = Math.min(4, Math.floor(messages.length / 2));
    const toSummarize = messages.slice(0, messages.length - keepCount);
    const toKeep = messages.slice(messages.length - keepCount);

    // Build a summary request
    const summaryContent = toSummarize
      .map((m) => {
        if (m.role === "tool_result") return `[tool_result ${m.name}]: ${m.output.slice(0, 500)}`;
        const prefix = m.role === "assistant" ? "Assistant" : "User";
        return `${prefix}: ${m.content.slice(0, 1000)}`;
      })
      .join("\n");

    try {
      const summaryResponse = await this.provider.call({
        model: this.config.model,
        systemPrompt: "You are a conversation summarizer. Summarize the following conversation history concisely, preserving key facts, decisions, and context needed for continuation. Be brief.",
        messages: [{ role: "user", content: `Summarize this conversation:\n\n${summaryContent}` }],
        tools: [], // Empty array, not null — providers expect an array
        maxTokens: 1024,
      });

      const summary = summaryResponse.text;
      if (!summary) return;

      // Replace messages array: summary + kept messages.
      // Ensure valid role alternation: summary is a user message,
      // so skip any leading user/tool_result messages from toKeep
      // to maintain user → assistant alternation for Claude API.
      messages.length = 0;
      messages.push({
        role: "user",
        content: `[Conversation summary: ${summary}]`,
      });
      // Drop leading non-assistant messages from toKeep to prevent user→user
      let startIdx = 0;
      while (startIdx < toKeep.length && toKeep[startIdx].role !== "assistant") {
        startIdx++;
      }
      messages.push(...toKeep.slice(startIdx));

      console.log(`[agent] Compacted ${sessionKey ?? "?"}: ${toSummarize.length} messages → summary (${summary.length} chars), kept ${toKeep.length} recent`);
    } catch (err) {
      // Non-fatal — if compaction fails, just continue with full history
      console.warn("[agent] Compaction failed, continuing with full history:", err);
    }
  }
}

// ─── Role alternation ────────────────────────────────────────────────

/**
 * Ensure conversation messages follow valid role alternation.
 * Claude API requires strict user → assistant → user → ... alternation.
 * tool_result messages count as "user" role (they're sent as user messages).
 * Ported from claude-code's ensureAlternatingRoles() / message validation.
 */
function ensureAlternatingRoles(messages: ProviderMessage[]): void {
  // Merge consecutive same-role messages
  let i = 0;
  while (i < messages.length - 1) {
    const curr = messages[i];
    const next = messages[i + 1];

    // tool_result is a "user" role message for Claude
    const currRole = curr.role === "tool_result" ? "user" : curr.role;
    const nextRole = next.role === "tool_result" ? "user" : next.role;

    if (currRole === nextRole && currRole === "user" && curr.role === "user" && next.role === "user") {
      // Merge consecutive user messages
      curr.content = curr.content + "\n\n" + next.content;
      messages.splice(i + 1, 1);
    } else {
      i++;
    }
  }

  // Ensure first message is from user
  if (messages.length > 0 && messages[0].role === "assistant") {
    messages.splice(0, 0, { role: "user", content: "[Conversation start]" });
  }
}
