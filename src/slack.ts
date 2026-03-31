import { App } from "@slack/bolt";
import type { AgentConfig } from "./types.js";
import type { Agent } from "./agent.js";
import { SessionStore } from "./session.js";

const SLACK_TEXT_LIMIT = 4000;
const HISTORY_LIMIT = 20;

export function createSlackApp(config: AgentConfig, agent: Agent, sessions: SessionStore): App {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  let botUserId: string | undefined;

  async function resolveBotId(client: any): Promise<string> {
    if (!botUserId) {
      const auth = await client.auth.test();
      botUserId = auth.user_id as string;
    }
    return botUserId;
  }

  // Handle direct mentions in channels
  app.event("app_mention", async ({ event, client }) => {
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
    const threadTs = msg.thread_ts as string | undefined;

    const myId = await resolveBotId(client);
    if (msg.user === myId) return;

    const isDM = channel.startsWith("D");
    const isThreadReply = !!threadTs;

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
}

async function handleMessage(params: HandleMessageParams): Promise<void> {
  const { agent, client, channel, ts, text, userId, sessionKey } = params;
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

  try {
    console.log(`[slack] Message from ${userId} in ${channel}: ${text.slice(0, 100)}`);
    console.log(`[slack] Session key: ${sessionKey}, replyThreadTs: ${replyThreadTs ?? "(flat)"}`);

    const reply = await agent.getReply(sessionKey, text, userId);
    console.log(`[slack] Reply (${reply.length} chars): ${reply.slice(0, 200)}`);

    // Send reply, chunking if needed
    const chunks = chunkText(reply, SLACK_TEXT_LIMIT);
    for (const chunk of chunks) {
      const result = await client.chat.postMessage({
        channel,
        text: chunk,
        ...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
      });
      console.log(`[slack] Posted message ok=${result.ok} ts=${result.ts}`);
    }
  } catch (err) {
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
