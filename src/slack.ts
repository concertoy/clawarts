import { App } from "@slack/bolt";
import type { AgentConfig } from "./types.js";
import type { Agent } from "./agent.js";
import { SessionStore } from "./session.js";
import { markdownToSlack } from "./utils/slack-markdown.js";
import { downloadSlackImages } from "./utils/slack-images.js";
import { downloadSlackFiles, formatFileAttachments } from "./utils/slack-files.js";
import { KeyedAsyncQueue } from "./queue/keyed-async-queue.js";
import { enqueueCommand } from "./queue/command-queue.js";
import { CommandLane } from "./queue/lanes.js";
import { enqueueFollowup, type FollowupItem } from "./queue/followup-queue.js";

const SLACK_TEXT_LIMIT = 4000;
const HISTORY_LIMIT = 20;
const STREAM_UPDATE_INTERVAL_MS = 1500; // Throttle Slack message edits to avoid rate limits

export function createSlackApp(config: AgentConfig, agent: Agent, sessions: SessionStore): App {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  // Increase ping timeout from default 5s to 30s to avoid constant reconnections
  const receiver = (app as any).receiver;
  if (receiver?.client) {
    receiver.client.clientPingTimeoutMS = 30_000;
  }

  const allowedUsers = config.allowedUsers ? new Set(config.allowedUsers) : null;

  // Per-session serialization: messages for the same session are processed
  // sequentially, but different sessions run in parallel.
  // Ported from OpenClaw's SessionActorQueue / KeyedAsyncQueue pattern.
  const sessionQueue = new KeyedAsyncQueue();

  let botUserId: string | undefined;
  const botDmChannels = new Set<string>(); // DM channels confirmed to be with the bot

  // Message deduplication: Slack can deliver duplicate events.
  // Track recently processed message timestamps to avoid double-processing.
  const processedMessages = new Set<string>();
  const DEDUP_TTL_MS = 60_000; // Keep dedup entries for 1 minute
  const DEDUP_MAX_SIZE = 1000; // Safety valve — prevent unbounded growth

  function isDuplicate(channel: string, ts: string): boolean {
    const key = `${channel}:${ts}`;
    if (processedMessages.has(key)) return true;
    // Safety valve: if set is too large, clear old entries
    if (processedMessages.size >= DEDUP_MAX_SIZE) {
      processedMessages.clear();
    }
    processedMessages.add(key);
    setTimeout(() => processedMessages.delete(key), DEDUP_TTL_MS);
    return false;
  }

  async function resolveBotId(client: any): Promise<string> {
    if (!botUserId) {
      const auth = await client.auth.test();
      botUserId = auth.user_id as string;
    }
    return botUserId;
  }

  /** Check if a DM channel is a 1:1 conversation with this bot. */
  async function isBotDM(client: any, channel: string, myId: string): Promise<boolean> {
    if (botDmChannels.has(channel)) return true;
    try {
      const resp = await client.conversations.members({ channel, limit: 10 });
      const members = resp.members as string[] | undefined;
      if (members?.includes(myId)) {
        botDmChannels.add(channel);
        return true;
      }
      return false;
    } catch (err) {
      console.warn(`[slack] isBotDM check failed for ${channel}:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  /**
   * Dispatch a message through the command queue and session queue.
   * Fire-and-forget from the Slack event handler's perspective.
   *
   * Flow: Slack event → command queue (main lane, concurrency-limited)
   *       → session queue (per-session serialization)
   *       → handleMessage (agent loop)
   *
   * If a session is already busy, the message is routed to the followup
   * queue which debounces and batches messages for delivery once the
   * agent finishes its current turn.
   */
  function dispatch(params: HandleMessageParams): void {
    void enqueueCommand(CommandLane.Main, () =>
      sessionQueue.enqueue(params.sessionKey, async () => {
        await handleMessage(params);
      }),
    ).catch((err) => {
      if (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"))) return;
      console.error(`[slack] Dispatch error for ${params.sessionKey}:`, err);
    });
  }

  /**
   * Dispatch a followup message for a session that's currently busy.
   * The followup queue debounces and batches messages, then delivers
   * them as a single combined message once the agent is free.
   */
  function dispatchFollowup(params: HandleMessageParams): void {
    const item: FollowupItem = {
      text: params.text,
      userId: params.userId,
      ts: params.ts,
      enqueuedAt: Date.now(),
    };

    // Prefix with agent ID to prevent cross-agent pollution in the
    // module-level followup queue (shared Maps between all agents).
    const followupKey = `${config.id}:${params.sessionKey}`;
    enqueueFollowup(followupKey, item, async (batch) => {
      // Combine batched messages into a single user message
      const combined = batch
        .map((i) => i.userId === "system" ? i.text : `[From: <@${i.userId}>]\n${i.text}`)
        .join("\n\n---\n\n");

      // Dispatch the combined message through the normal flow
      dispatch({
        ...params,
        text: combined,
      });
    });
  }

  // Handle direct mentions in channels
  app.event("app_mention", async ({ event, client }) => {
    if (isDuplicate(event.channel, event.ts)) return;
    if (allowedUsers && event.user && !allowedUsers.has(event.user)) return;

    const myId = await resolveBotId(client);

    const text = stripMention(event.text, myId);
    if (!text.trim()) return;

    const sessionKey = SessionStore.deriveKey(event.channel, event.ts, event.thread_ts);

    // Hydrate from Slack API if session is cold (new or after restart).
    // Call get() first to trigger disk restore — only fetch from Slack if truly empty.
    if (!sessions.has(sessionKey)) {
      const restored = sessions.get(sessionKey);
      if (restored.messages.length === 0 && event.thread_ts) {
        await hydrateFromThread(client, sessions, sessionKey, event.channel, event.thread_ts, myId);
      }
    }

    const params: HandleMessageParams = {
      agent,
      client,
      channel: event.channel,
      ts: event.ts,
      threadTs: event.thread_ts ?? event.ts,
      text,
      userId: event.user ?? "unknown",
      sessionKey,
      botToken: config.slackBotToken,
      files: (event as unknown as { files?: Array<Record<string, unknown>> }).files,
    };

    // If THIS session is already processing, route to followup queue.
    // Only check the specific session — not all sessions (OpenClaw pattern).
    if (sessionQueue.has(params.sessionKey)) {
      dispatchFollowup(params);
    } else {
      dispatch(params);
    }
  });

  // Handle DMs and thread replies in channels
  app.event("message", async ({ event, client }) => {
    const msg = event as unknown as {
      subtype?: string;
      text?: string;
      user?: string;
      channel: string;
      ts: string;
      thread_ts?: string;
      files?: Array<Record<string, unknown>>;
      message?: { text?: string; user?: string; files?: Array<Record<string, unknown>> };
    };

    // Skip non-standard messages (edits, deletes, bot messages, etc.)
    // Allow "message_changed" edits through — Slack auto-reformats punctuation
    // (e.g. smart quotes) as an edit, dropping the original if we skip it here.
    if (msg.subtype && msg.subtype !== "message_changed") return;

    // For message_changed, use the edited message's text and user
    const text_raw = msg.subtype === "message_changed" ? msg.message?.text : msg.text;
    const user_raw = msg.subtype === "message_changed" ? msg.message?.user : msg.user;
    if (!text_raw) return;
    if (allowedUsers && user_raw && !allowedUsers.has(user_raw as string)) return;

    const channel = msg.channel as string;
    const ts = msg.ts as string;
    const threadTs = msg.thread_ts as string | undefined;

    const myId = await resolveBotId(client);
    if (user_raw === myId) return;

    const isDM = channel.startsWith("D");
    const isThreadReply = !!threadTs;

    // Only respond in DMs where the bot is a participant
    if (isDM && !(await isBotDM(client, channel, myId))) return;

    if (!isDM && !isThreadReply) {
      // Top-level channel message without @mention — handled by app_mention
      return;
    }

    if (!isDM && isThreadReply) {
      // Channel thread reply: only respond if bot is active in this thread
      const sessionKey = SessionStore.deriveKey(channel, ts, threadTs);
      if (!sessions.has(sessionKey)) return;
    }

    // Dedup AFTER skip checks — otherwise we poison the dedup set for
    // messages this handler skips, blocking the app_mention handler.
    if (isDuplicate(channel, ts)) return;

    const sessionKey = SessionStore.deriveKey(channel, ts, threadTs);
    const text = isDM ? (text_raw as string) : stripMention(text_raw as string, myId);

    // Hydrate from Slack API if session is cold (new or after restart).
    // Call get() first to trigger disk restore — only fetch from Slack if truly empty.
    if (!sessions.has(sessionKey)) {
      const restored = sessions.get(sessionKey);
      if (restored.messages.length === 0) {
        if (isDM) {
          await hydrateFromDM(client, sessions, sessionKey, channel, myId);
        } else if (isThreadReply) {
          await hydrateFromThread(client, sessions, sessionKey, channel, threadTs!, myId);
        }
      }
    }

    const params: HandleMessageParams = {
      agent,
      client,
      channel,
      ts,
      threadTs,
      text,
      userId: (user_raw as string) ?? "unknown",
      sessionKey,
      botToken: config.slackBotToken,
      files: msg.subtype === "message_changed" ? msg.message?.files : msg.files,
    };

    // If THIS session is already processing, route to followup queue.
    // Only check the specific session — not all sessions (OpenClaw pattern).
    if (sessionQueue.has(params.sessionKey)) {
      dispatchFollowup(params);
    } else {
      dispatch(params);
    }
  });

  return app;
}

// ─── History hydration from Slack API ───────────────────────────────────

/**
 * Fetch recent DM history via conversations.history().
 * Called on cold session so the bot has context even after restart.
 */
async function hydrateFromDM(
  client: any,
  sessions: SessionStore,
  sessionKey: string,
  channel: string,
  botUserId: string,
): Promise<void> {
  try {
    const response = await client.conversations.history({
      channel,
      limit: HISTORY_LIMIT,
    });

    const messages = response?.messages as Array<{ text?: string; user?: string; ts?: string }> | undefined;
    if (!messages || messages.length === 0) return;

    const session = sessions.get(sessionKey);

    // conversations.history returns newest-first, reverse for chronological order
    const sorted = [...messages].reverse();
    for (const msg of sorted) {
      if (!msg.text || !msg.user) continue;
      const role = msg.user === botUserId ? "assistant" : "user";
      const content = role === "user" ? `[From: <@${msg.user}>]\n${msg.text}` : msg.text;
      session.messages.push({ role, content });
    }

    if (session.messages.length > 0) {
      console.log(`[slack] Hydrated ${session.messages.length} messages from DM history (${sessionKey})`);
    }
  } catch (err) {
    console.warn(`[slack] Failed to fetch DM history (${sessionKey}):`, err);
  }
}

/**
 * Fetch thread replies via conversations.replies().
 * Called on cold session for channel threads.
 */
async function hydrateFromThread(
  client: any,
  sessions: SessionStore,
  sessionKey: string,
  channel: string,
  threadTs: string,
  botUserId: string,
): Promise<void> {
  try {
    const response = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: HISTORY_LIMIT,
      inclusive: true,
    });

    const messages = response?.messages as Array<{ text?: string; user?: string; ts?: string }> | undefined;
    if (!messages || messages.length === 0) return;

    const session = sessions.get(sessionKey);

    for (const msg of messages) {
      if (!msg.text || !msg.user) continue;
      const role = msg.user === botUserId ? "assistant" : "user";
      const content = role === "user" ? `[From: <@${msg.user}>]\n${msg.text}` : msg.text;
      session.messages.push({ role, content });
    }

    if (session.messages.length > 0) {
      console.log(`[slack] Hydrated ${session.messages.length} messages from thread history (${sessionKey})`);
    }
  } catch (err) {
    console.warn(`[slack] Failed to fetch thread history (${sessionKey}):`, err);
  }
}

// ─── Message handling ───────────────────────────────────────────────────

interface HandleMessageParams {
  agent: Agent;
  client: any;
  channel: string;
  ts: string;
  threadTs: string | undefined;
  text: string;
  userId: string;
  sessionKey: string;
  botToken: string;
  files?: Array<Record<string, unknown>>;
}

async function handleMessage(params: HandleMessageParams): Promise<void> {
  const { agent, client, channel, ts, text, userId, sessionKey, botToken } = params;
  const isDM = channel.startsWith("D");

  // Route reply to where the message came from:
  // - DM thread reply → reply in that thread
  // - DM top-level → reply flat
  // - Channel → always reply in thread
  let replyThreadTs: string | undefined;
  if (isDM) {
    replyThreadTs = params.threadTs; // undefined for top-level, set for thread replies
  } else {
    replyThreadTs = params.threadTs ?? ts;
  }

  // Add thinking indicator
  try {
    await client.reactions.add({ channel, timestamp: ts, name: "eyes" });
  } catch {
    // Reaction may fail if already added or permissions missing
  }

  // Streaming state — hoisted so finally block can clean up the timer
  let pendingEdit: ReturnType<typeof setTimeout> | null = null;

  try {
    console.log(`[slack] Message from ${userId} in ${channel}: ${text.slice(0, 100)}`);
    console.log(`[slack] Session key: ${sessionKey}, replyThreadTs: ${replyThreadTs ?? "(flat)"}`);

    // Post a placeholder message that we'll progressively update as text streams in
    const placeholder = await client.chat.postMessage({
      channel,
      text: ":hourglass_flowing_sand: Thinking...",
      ...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
    });
    const placeholderTs = placeholder.ts as string | undefined;

    // Streaming state: accumulate text deltas and throttle Slack edits
    let streamedText = "";
    let lastEditAt = 0;

    const flushEdit = async () => {
      if (!placeholderTs || !streamedText) return;
      const now = Date.now();
      // Only edit if we have text and enough time has passed
      if (now - lastEditAt < STREAM_UPDATE_INTERVAL_MS) return;
      lastEditAt = now;
      const slackText = markdownToSlack(streamedText);
      const displayText = slackText.length > SLACK_TEXT_LIMIT
        ? slackText.slice(0, SLACK_TEXT_LIMIT) + "\n\n_(truncated — see thread for full response)_"
        : slackText + " :writing_hand:";
      try {
        await client.chat.update({ channel, ts: placeholderTs, text: displayText });
      } catch {
        // Edit may fail under rate limits — non-fatal
      }
    };

    const onText = (delta: string) => {
      streamedText += delta;
      // Schedule a throttled edit
      if (!pendingEdit) {
        pendingEdit = setTimeout(() => {
          pendingEdit = null;
          void flushEdit().catch(() => {});
        }, STREAM_UPDATE_INTERVAL_MS);
      }
    };

    // Download image attachments if present (ported from claude-code attachment handling)
    // Slack file objects match the SlackFile interface but come as Record<string, unknown> from event typing
    const slackFiles = params.files as any;
    const { images, skipped: skippedImages } = await downloadSlackImages(slackFiles, botToken);

    // Download non-image file attachments and prepend text content to message
    const fileAttachments = await downloadSlackFiles(slackFiles, botToken);
    const filePrefix = formatFileAttachments(fileAttachments);
    // Notify user about skipped images so they know why their attachment wasn't processed
    const skippedNotice = skippedImages.length > 0
      ? `[Note: ${skippedImages.length} image(s) skipped — ${skippedImages.join("; ")}]\n`
      : "";
    const messageWithFiles = filePrefix || skippedNotice ? `${skippedNotice}${filePrefix}\n---\n${text}` : text;

    const onToolStart = (toolNames: string[]) => {
      if (!placeholderTs) return;
      const label = toolNames.length === 1 ? toolNames[0] : toolNames.join(", ");
      client.chat.update({ channel, ts: placeholderTs, text: `:gear: Running ${label}...` }).catch(() => {});
    };

    const rawReply = await agent.getReply(sessionKey, messageWithFiles, userId, { channelId: channel, threadTs: replyThreadTs }, onText, images.length > 0 ? images : undefined, onToolStart);
    console.log(`[slack] Reply (${rawReply.length} chars): ${rawReply.slice(0, 200)}`);

    // Clear any pending throttled edit
    if (pendingEdit) {
      clearTimeout(pendingEdit);
      pendingEdit = null;
    }

    // Convert GitHub markdown → Slack mrkdwn before posting
    const reply = markdownToSlack(rawReply);

    // Final update: replace placeholder with complete response
    const chunks = chunkText(reply, SLACK_TEXT_LIMIT);
    if (placeholderTs && chunks.length > 0) {
      // Update the placeholder message with the first chunk
      try {
        await client.chat.update({ channel, ts: placeholderTs, text: chunks[0] });
      } catch {
        // If update fails, post as new message
        await client.chat.postMessage({
          channel,
          text: chunks[0],
          ...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
        });
      }
      // Post remaining chunks as new messages
      for (let i = 1; i < chunks.length; i++) {
        await client.chat.postMessage({
          channel,
          text: chunks[i],
          ...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
        });
      }
    }
  } catch (err) {
    // Aborted requests (from AbortController) are expected — don't post error
    if (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"))) {
      console.log(`[slack] Request aborted for ${sessionKey} — suppressing error`);
      return;
    }

    console.error("[slack] Error handling message:", err);
    const errMsg = err instanceof Error ? err.message : String(err);
    try {
      await client.chat.postMessage({
        channel,
        text: `\`\`\`\n${errMsg}\n\`\`\``,
        ...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
      });
    } catch {
      // Best effort error reporting
    }
  } finally {
    // Clean up any pending streaming timer to prevent leaks
    if (pendingEdit) {
      clearTimeout(pendingEdit);
      pendingEdit = null;
    }
    // Remove thinking indicator
    try {
      await client.reactions.remove({ channel, timestamp: ts, name: "eyes" });
    } catch {
      // May fail if reaction was already removed
    }
  }
}

function stripMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to break at a newline
    let breakPoint = remaining.lastIndexOf("\n", limit);
    if (breakPoint <= 0) {
      breakPoint = remaining.lastIndexOf(" ", limit);
    }
    if (breakPoint <= 0) {
      breakPoint = limit;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}
