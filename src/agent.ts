import type { AgentConfig, Skill, ToolDefinition, ToolUseContext, WorkspaceFile } from "./types.js";
import type { ImageContent, ModelProvider, ProviderMessage } from "./provider.js";
import { SessionStore } from "./session.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { loadWorkspaceFiles } from "./workspace.js";
import { runToolBatch } from "./tool-runner.js";
import { touchAgent, recordAgentError } from "./relay.js";
import { errMsg, isAbortError } from "./utils/errors.js";
import { createRateLimiter, type RateLimiter } from "./utils/rate-limit.js";
import { recordTokenUsage } from "./utils/token-tracker.js";
import { createLogger } from "./utils/logger.js";

const DEFAULT_MAX_TOOL_ITERATIONS = 10;
const AGENT_LOOP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max for entire agent loop

/** Default: 30 requests per 60 seconds per agent. */
const DEFAULT_RATE_LIMIT_REQUESTS = 30;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Estimated character threshold for triggering compaction.
 * ~80K chars ≈ 20K tokens — leaves headroom for the model's context window.
 * Ported from claude-code's autoCompact threshold logic (simplified).
 */
const COMPACTION_CHAR_THRESHOLD = 80_000;

// ─── Agent ──────────────────────────────────────────────────────────────

export class Agent {
  private readonly log;
  private systemPrompt: string;
  private readonly toolDefs: ToolDefinition[];
  private readonly skills: Skill[];
  private lastWorkspaceFiles: WorkspaceFile[];

  /** Expose loaded workspace files for status reporting. */
  get workspaceFiles(): readonly WorkspaceFile[] {
    return this.lastWorkspaceFiles;
  }

  /** Expose tool names for status reporting. */
  get toolNames(): string[] {
    return this.toolDefs.map((t) => t.name);
  }

  /**
   * Track in-flight AbortControllers per session.
   * When a new message arrives for a session that already has an active request,
   * the old request is canceled to prevent stale responses.
   * Ported from claude-code's abortController pattern.
   */
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly rateLimiter: RateLimiter;

  constructor(
    private readonly config: AgentConfig,
    private readonly provider: ModelProvider,
    private readonly sessions: SessionStore,
    skills: Skill[],
    tools: ToolDefinition[],
    workspaceFiles: WorkspaceFile[],
  ) {
    this.log = createLogger(`agent:${config.id}`);
    this.skills = skills;
    this.lastWorkspaceFiles = workspaceFiles;
    this.systemPrompt = buildSystemPrompt({
      identity: config.systemPrompt,
      skills,
      workspaceFiles,
      tools,
      helpLevel: config.helpLevel,
    });
    this.toolDefs = tools;
    this.rateLimiter = createRateLimiter({
      maxRequests: config.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_REQUESTS,
      windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
    });
  }

  /**
   * Reload workspace files from disk if they changed.
   * loadWorkspaceFiles() uses mtime-based caching, so this is cheap
   * when nothing changed. Allows professor to edit SOUL.md without restart.
   */
  private refreshSystemPrompt(): void {
    const fresh = loadWorkspaceFiles(this.config.workspaceDir);
    // Quick identity check — same array ref means cache hit (unchanged)
    if (fresh === this.lastWorkspaceFiles) return;
    this.lastWorkspaceFiles = fresh;
    this.systemPrompt = buildSystemPrompt({
      identity: this.config.systemPrompt,
      skills: this.skills,
      workspaceFiles: fresh,
      tools: this.toolDefs,
      helpLevel: this.config.helpLevel,
    });
    this.log.info("Workspace files changed, system prompt rebuilt");
  }

  async getReply(
    sessionKey: string,
    userMessage: string,
    userId: string,
    context?: { channelId?: string; threadTs?: string },
    onText?: (delta: string) => void,
    images?: ImageContent[],
    onToolStart?: (toolNames: string[]) => void,
  ): Promise<string> {
    // Hot-reload workspace files (SOUL.md etc.) if they changed on disk
    this.refreshSystemPrompt();

    // Quiet hours: return canned message without calling the API
    if (this.config.quietHours && isQuietHours(this.config.quietHours, this.config.quietHoursTimezone)) {
      touchAgent(this.config.id);
      const endTime = this.config.quietHours.split("-")[1];
      const tzNote = this.config.quietHoursTimezone ? ` (${this.config.quietHoursTimezone})` : "";
      return `I'm currently offline during quiet hours (${this.config.quietHours}${tzNote}). I'll be back at ${endTime}. Save your question and I'll help you then!`;
    }

    // Rate limit: prevent runaway API calls (ported from openclaw's fixed-window limiter)
    const limit = this.rateLimiter.consume();
    if (!limit.allowed) {
      const waitSec = Math.ceil(limit.retryAfterMs / 1000);
      this.log.warn(`Rate limited: retry in ${waitSec}s`);
      touchAgent(this.config.id);
      return `I'm receiving too many messages right now. Please wait ${waitSec} seconds and try again.`;
    }

    // Cancel any in-flight request for this session (ported from claude-code abortController)
    const existingController = this.activeRequests.get(sessionKey);
    if (existingController) {
      existingController.abort();
      this.log.debug(`Canceled in-flight request for session ${sessionKey}`);
    }
    const abortController = new AbortController();
    this.activeRequests.set(sessionKey, abortController);

    // Safety timeout — abort after 5 minutes to prevent indefinite hangs
    const loopTimeout = setTimeout(() => {
      this.log.warn(`Agent loop timeout (${AGENT_LOOP_TIMEOUT_MS / 1000}s) — aborting`);
      abortController.abort();
    }, AGENT_LOOP_TIMEOUT_MS);
    if (loopTimeout.unref) loopTimeout.unref();

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
      ...session.messages
        .filter((m) => m.content) // skip empty/corrupted messages from disk restore
        .map((m) => ({ role: m.role, content: m.content })),
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
    let toolErrorCount = 0;

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
        await this.compactIfNeeded(messages, sessionKey);

        // Check if aborted before making API call
        if (abortController.signal.aborted) {
          this.log.debug(`Request aborted before turn ${turnCount}`);
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
          this.log.info(`max_tokens hit (recovery ${maxTokensRecoveryCount}/${MAX_TOKEN_RECOVERIES}), continuing`);
          // Drop tool calls from truncated responses — they likely have incomplete JSON
          // arguments and would create dangling tool_use blocks without matching tool_result.
          // Ported from claude-code's max_tokens recovery that only preserves text.
          const validToolCalls = response.toolCalls.filter((tc) => {
            try { JSON.parse(tc.arguments); return true; } catch {
              this.log.warn(`Dropped truncated tool call: ${tc.name} (invalid JSON in arguments)`);
              return false;
            }
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

        // Warn if max_tokens hit but recovery exhausted
        if (response.stopReason === "max_tokens" && maxTokensRecoveryCount >= MAX_TOKEN_RECOVERIES) {
          this.log.warn(`max_tokens recovery exhausted (${MAX_TOKEN_RECOVERIES} attempts) — response may be truncated`);
        }

        // Exit: no tool calls or model chose to stop
        if (response.toolCalls.length === 0 || response.stopReason !== "tool_use") {
          break;
        }

        // Safety limit
        const maxIterations = this.config.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
        if (turnCount >= maxIterations) {
          this.log.info(`Hit max tool iterations (${maxIterations})`);
          break;
        }

        // Append assistant message (with tool calls) to conversation
        messages.push({
          role: "assistant",
          content: response.text,
          toolCalls: response.toolCalls,
        });

        // Notify caller which tools are about to run (for Slack status updates)
        if (onToolStart) {
          onToolStart(response.toolCalls.map((tc) => tc.name));
        }

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

        toolErrorCount += results.filter((r) => r.isError).length;
        this.log.debug(`Turn ${turnCount}: ${results.map((r) => r.name).join(", ")}`);
      }
    } catch (err) {
      // Re-throw abort errors (handled by caller in slack.ts)
      if (isAbortError(err)) {
        throw err;
      }
      // Log unexpected errors but still save partial response
      this.log.error(`Error in agent loop (turn ${turnCount}):`, err);
      recordAgentError(this.config.id, errMsg(err));
      if (!lastText) {
        lastText = "[An error occurred while processing your request. Please try again.]";
      }
    } finally {
      clearTimeout(loopTimeout);
      // Always clean up abort controller — prevents memory leaks
      this.activeRequests.delete(sessionKey);
    }

    const elapsedSec = ((Date.now() - agentStartMs) / 1000).toFixed(1);
    const cacheInfo = totalCacheReadTokens > 0 ? `, cache: ${totalCacheReadTokens} read / ${totalCacheCreationTokens} created` : "";
    const errorInfo = toolErrorCount > 0 ? `, ${toolErrorCount} tool error(s)` : "";
    this.log.info(`Complete: ${turnCount} turns in ${elapsedSec}s, ${totalInputTokens} input + ${totalOutputTokens} output tokens${cacheInfo}${errorInfo}`);

    // Record cumulative token usage for status reporting
    const latencyMs = Date.now() - agentStartMs;
    const hadError = toolErrorCount > 0;
    recordTokenUsage(this.config.id, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens, latencyMs, hadError);

    const reply = lastText || "[No response]";
    session.messages.push({ role: "assistant", content: reply });
    this.sessions.truncate(session);
    this.sessions.persistSession(sessionKey);
    touchAgent(this.config.id);
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
    sessionKey?: string,
  ): Promise<void> {
    const totalChars = messages.reduce((sum, m) => {
      let size = m.role === "tool_result" ? m.output.length : m.content.length;
      if (m.role === "assistant" && m.toolCalls) {
        size += m.toolCalls.reduce((s, tc) => s + tc.arguments.length, 0);
      }
      // Account for base64 image data (each image ~1.33x original bytes in base64)
      if (m.role === "user" && m.images) {
        size += m.images.reduce((s, img) => s + img.base64.length, 0);
      }
      return sum + size;
    }, 0);

    const threshold = this.config.compactionThreshold ?? COMPACTION_CHAR_THRESHOLD;
    if (totalChars < threshold || messages.length < 6) return;

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
        systemPrompt: "Summarize this conversation history concisely. Preserve: key facts, decisions made, pending tasks, user preferences, and any context needed for the assistant to continue naturally. Focus on what matters for continuation, not what was said verbatim. Be brief — 3-5 sentences max.",
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

      this.log.info(`Compacted ${sessionKey ?? "?"}: ${toSummarize.length + toKeep.length} → ${messages.length} messages (${totalChars} → ~${summary.length} chars)`);
    } catch (err) {
      // Non-fatal — if compaction fails, just continue with full history
      this.log.warn("Compaction failed, continuing with full history:", errMsg(err));
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

// ─── Quiet hours ────────────────────────────────────────────────────

/** Check if current time falls within quiet hours (format: "HH:MM-HH:MM"). */
export function isQuietHours(range: string, timezone?: string): boolean {
  const match = range.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!match) return false;

  const now = new Date();
  let currentMinutes: number;
  if (timezone) {
    // Use Intl.DateTimeFormat to get hours/minutes in the specified timezone
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "numeric", hour12: false });
    const parts = fmt.formatToParts(now);
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
    currentMinutes = hour * 60 + minute;
  } else {
    currentMinutes = now.getHours() * 60 + now.getMinutes();
  }
  const startMinutes = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  const endMinutes = parseInt(match[3], 10) * 60 + parseInt(match[4], 10);

  // Handle overnight ranges (e.g., 23:00-07:00)
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}
