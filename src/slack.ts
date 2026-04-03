import { App } from "@slack/bolt";
import type { AgentConfig } from "./types.js";
import type { Agent } from "./agent.js";
import { SessionStore } from "./session.js";
import { markdownToSlack } from "./utils/slack-markdown.js";
import { downloadSlackImages } from "./utils/slack-images.js";

const SLACK_TEXT_LIMIT = 4000;
const HISTORY_LIMIT = 20;
const STREAM_UPDATE_INTERVAL_MS = 1500; // Throttle Slack message edits to avoid rate limits

export function createSlackApp(config: AgentConfig, agent: Agent, sessions: SessionStore): App {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  let botUserId: string | undefined;
  const botDmChannels = new Set<string>(); // DM channels confirmed to be with the bot

  // Message deduplication: Slack can deliver duplicate events.
  // Track recently processed message timestamps to avoid double-processing.
  const processedMessages = new Set<string>();
  const DEDUP_TTL_MS = 60_000; // Keep dedup entries for 1 minute

  function isDuplicate(channel: string, ts: string): boolean {
    const key = `${channel}:${ts}`;
    if (processedMessages.has(key)) return true;
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
    } catch {
      return false;
    }
  }

  // Handle direct mentions in channels
  app.event("app_mention", async ({ event, client }) => {
    if (isDuplicate(event.channel, event.ts)) return;

    const myId = await resolveBotId(client);

    const text = stripMention(event.text, myId);
    if (!text.trim()) return;

    const sessionKey = SessionStore.deriveKey(event.channel, event.ts, event.thread_ts);

    // Hydrate from Slack API if session is cold (new or after restart)
    if (!sessions.has(sessionKey)) {
      if (event.thread_ts) {
        await hydrateFromThread(client, sessions, sessionKey, event.channel, event.thread_ts, myId);
      }
    }

    await handleMessage({
      agent,
      client,
      channel: event.channel,
      ts: event.ts,
      threadTs: event.thread_ts ?? event.ts,
      text,
      userId: event.user ?? "unknown",
      sessionKey,
      botToken: config.slackBotToken,
      files: (event as any).files,
    });
  });

  // Handle DMs and thread replies in channels
  app.event("message", async ({ event, client }) => {
    const msg = event as Record<string, any>;

    // Skip non-standard messages (edits, deletes, bot messages, etc.)
    if (msg.subtype) return;
    if (!msg.text) return;

    const channel = msg.channel as string;
    const ts = msg.ts as string;

    if (isDuplicate(channel, ts)) return;
    const threadTs = msg.thread_ts as string | undefined;

    const myId = await resolveBotId(client);
    if (msg.user === myId) return;

    const isDM = channel.startsWith("D");
    const isThreadReply = !!threadTs;

    // Only respond in DMs where the bot is a participant
    if (isDM && !(await isBotDM(client, channel, myId))) return;

    if (!isDM && !isThreadReply) {
      // Top-level channel message without @mention — skip
      return;
    }

    if (!isDM && isThreadReply) {
      // Channel thread reply: only respond if bot is active in this thread
      const sessionKey = SessionStore.deriveKey(channel, ts, threadTs);
      if (!sessions.has(sessionKey)) return;
    }

    const sessionKey = SessionStore.deriveKey(channel, ts, threadTs);
    const text = isDM ? (msg.text as string) : stripMention(msg.text as string, myId);

    // Hydrate from Slack API if session is cold (new or after restart)
    if (!sessions.has(sessionKey)) {
      if (isDM) {
        await hydrateFromDM(client, sessions, sessionKey, channel, myId);
      } else if (isThreadReply) {
        await hydrateFromThread(client, sessions, sessionKey, channel, threadTs!, myId);
      }
    }

    await handleMessage({
      agent,
      client,
      channel,
      ts,
      threadTs,
      text,
      userId: (msg.user as string) ?? "unknown",
      sessionKey,
      botToken: config.slackBotToken,
      files: msg.files as Array<Record<string, unknown>> | undefined,
    });
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
      console.log(`[slack] Hydrated ${session.messages.length} messages from DM history`);
    }
  } catch (err) {
    console.warn("[slack] Failed to fetch DM history:", err);
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
      console.log(`[slack] Hydrated ${session.messages.length} messages from thread history`);
    }
  } catch (err) {
    console.warn("[slack] Failed to fetch thread history:", err);
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
        pendingEdit = setTimeout(async () => {
          pendingEdit = null;
          await flushEdit();
        }, STREAM_UPDATE_INTERVAL_MS);
      }
    };

    // Download image attachments if present (ported from claude-code attachment handling)
    const images = await downloadSlackImages(params.files as any, botToken);

    const rawReply = await agent.getReply(sessionKey, text, userId, { channelId: channel, threadTs: replyThreadTs }, onText, images.length > 0 ? images : undefined);
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
