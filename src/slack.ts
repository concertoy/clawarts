import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { AgentConfig } from "./types.js";
import type { Agent } from "./agent.js";
import { SessionStore } from "./session.js";
import { BoundedMap } from "./utils/bounded-map.js";
import { errMsg } from "./utils/errors.js";
import { markdownToSlack } from "./utils/slack-markdown.js";
import { downloadSlackImages } from "./utils/slack-images.js";
import { downloadSlackFiles, formatFileAttachments } from "./utils/slack-files.js";
import type { SlackFile } from "./utils/slack-types.js";
import { KeyedAsyncQueue } from "./queue/keyed-async-queue.js";
import { enqueueCommand } from "./queue/command-queue.js";
import { CommandLane } from "./queue/lanes.js";
import { enqueueFollowup, type FollowupItem } from "./queue/followup-queue.js";

const SLACK_TEXT_LIMIT = 4000;
const HISTORY_LIMIT = 20;
const STREAM_UPDATE_INTERVAL_MS = 1500;
const SOCKET_PING_TIMEOUT_MS = 30_000;

export function createSlackApp(config: AgentConfig, agent: Agent, sessions: SessionStore): App {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  // Increase ping timeout from default 5s to 30s to avoid constant reconnections.
  // This accesses Bolt internals — wrapped in try/catch for forward compatibility.
  try {
    const receiver = (app as any).receiver;
    if (receiver?.client) {
      receiver.client.clientPingTimeoutMS = SOCKET_PING_TIMEOUT_MS;
    }
  } catch {
    // Bolt internals may change — non-fatal
  }

  const allowedUsers = config.allowedUsers ? new Set(config.allowedUsers) : null;

  // Per-session serialization: messages for the same session are processed
  // sequentially, but different sessions run in parallel.
  // Ported from OpenClaw's SessionActorQueue / KeyedAsyncQueue pattern.
  const sessionQueue = new KeyedAsyncQueue();

  let botUserIdPromise: Promise<string> | undefined;
  const botDmChannels = new Set<string>(); // DM channels confirmed to be with the bot

  // Message deduplication: Slack can deliver duplicate events.
  // Track recently processed message timestamps to avoid double-processing.
  // Uses a Map<key, timestamp> with periodic sweep instead of per-message timers
  // to avoid orphaned setTimeout handles when the safety valve clears entries.
  const DEDUP_TTL_MS = 60_000;
  const DEDUP_MAX_SIZE = 1000;
  const DEDUP_SWEEP_INTERVAL_MS = 30_000;
  const processedMessages = new BoundedMap<string, number>(DEDUP_MAX_SIZE);

  // Periodic sweep to expire old entries — cheaper than per-message timers
  const dedupSweepTimer = setInterval(() => {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [k, t] of processedMessages) {
      if (t < cutoff) processedMessages.delete(k);
    }
  }, DEDUP_SWEEP_INTERVAL_MS);
  if (dedupSweepTimer.unref) dedupSweepTimer.unref();

  function isDuplicate(channel: string, ts: string): boolean {
    const key = `${channel}:${ts}`;
    if (processedMessages.has(key)) return true;
    processedMessages.set(key, Date.now()); // BoundedMap handles eviction
    return false;
  }

  async function resolveBotId(client: WebClient): Promise<string> {
    // Cache the promise (not just the result) to prevent duplicate auth.test()
    // calls when multiple events arrive before the first resolves.
    if (!botUserIdPromise) {
      botUserIdPromise = (client.auth.test() as Promise<{ user_id: string }>).then((auth) => auth.user_id);
    }
    return botUserIdPromise;
  }

  /** Check if a DM channel is a 1:1 conversation with this bot. */
  async function isBotDM(client: WebClient, channel: string, myId: string): Promise<boolean> {
    if (botDmChannels.has(channel)) return true;
    try {
      const resp = await client.conversations.members({ channel, limit: 10 });
      if (resp.members?.includes(myId)) {
        botDmChannels.add(channel);
        return true;
      }
      return false;
    } catch (err) {
      console.warn(`[slack] isBotDM check failed for ${channel}:`, errMsg(err));
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
      console.error(`[slack] Dispatch error for ${params.sessionKey}:`, errMsg(err));
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
      files: (event as unknown as { files?: SlackFile[] }).files,
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
      files?: SlackFile[];
      message?: { text?: string; user?: string; files?: SlackFile[] };
    };

    // Skip non-standard messages (edits, deletes, bot messages, etc.)
    // Allow "message_changed" edits through — Slack auto-reformats punctuation
    // (e.g. smart quotes) as an edit, dropping the original if we skip it here.
    if (msg.subtype && msg.subtype !== "message_changed") return;

    // For message_changed, use the edited message's text and user
    const text_raw = msg.subtype === "message_changed" ? msg.message?.text : msg.text;
    const user_raw = msg.subtype === "message_changed" ? msg.message?.user : msg.user;
    if (!text_raw) return;
    if (allowedUsers && user_raw && !allowedUsers.has(user_raw)) return;

    const { channel, ts } = msg;
    const threadTs = msg.thread_ts;

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
    const text = isDM ? text_raw : stripMention(text_raw, myId);

    // Hydrate from Slack API if session is cold (new or after restart).
    // Call get() first to trigger disk restore — only fetch from Slack if truly empty.
    if (!sessions.has(sessionKey)) {
      const restored = sessions.get(sessionKey);
      if (restored.messages.length === 0) {
        if (isDM) {
          await hydrateFromDM(client, sessions, sessionKey, channel, myId);
        } else if (isThreadReply && threadTs) {
          await hydrateFromThread(client, sessions, sessionKey, channel, threadTs, myId);
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
      userId: user_raw ?? "unknown",
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

type SlackMessage = { text?: string; user?: string; ts?: string };

/** Convert raw Slack messages to session messages and append to session. */
function ingestMessages(
  sessions: SessionStore,
  sessionKey: string,
  messages: SlackMessage[],
  botUserId: string,
): number {
  const session = sessions.get(sessionKey);
  let count = 0;
  for (const msg of messages) {
    if (!msg.text || !msg.user) continue;
    const role = msg.user === botUserId ? "assistant" : "user";
    const content = role === "user" ? `[From: <@${msg.user}>]\n${msg.text}` : msg.text;
    session.messages.push({ role, content });
    count++;
  }
  return count;
}

/**
 * Fetch recent DM history via conversations.history().
 * Called on cold session so the bot has context even after restart.
 */
async function hydrateFromDM(
  client: WebClient,
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

    const messages = response?.messages as SlackMessage[] | undefined;
    if (!messages || messages.length === 0) return;

    // conversations.history returns newest-first, reverse for chronological order
    const count = ingestMessages(sessions, sessionKey, [...messages].reverse(), botUserId);
    if (count > 0) {
      console.log(`[slack] Hydrated ${count} messages from DM history (${sessionKey})`);
    }
  } catch (err) {
    console.warn(`[slack] Failed to fetch DM history (${sessionKey}):`, errMsg(err));
  }
}

/**
 * Fetch thread replies via conversations.replies().
 * Called on cold session for channel threads.
 */
async function hydrateFromThread(
  client: WebClient,
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

    const messages = response?.messages as SlackMessage[] | undefined;
    if (!messages || messages.length === 0) return;

    const count = ingestMessages(sessions, sessionKey, messages, botUserId);
    if (count > 0) {
      console.log(`[slack] Hydrated ${count} messages from thread history (${sessionKey})`);
    }
  } catch (err) {
    console.warn(`[slack] Failed to fetch thread history (${sessionKey}):`, errMsg(err));
  }
}

// ─── Message handling ───────────────────────────────────────────────────

interface HandleMessageParams {
  agent: Agent;
  client: WebClient;
  channel: string;
  ts: string;
  threadTs: string | undefined;
  text: string;
  userId: string;
  sessionKey: string;
  botToken: string;
  files?: SlackFile[];
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
    console.log(`[slack] ${sessionKey} from ${userId}: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`);

    // Post a placeholder message that we'll progressively update as text streams in
    const placeholder = await client.chat.postMessage({
      channel,
      text: ":hourglass_flowing_sand: Thinking...",
      ...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
    });
    const placeholderTs = placeholder.ts;

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
          void flushEdit().catch((err) => console.debug("[slack] Stream edit failed:", errMsg(err)));
        }, STREAM_UPDATE_INTERVAL_MS);
        if (pendingEdit.unref) pendingEdit.unref();
      }
    };

    // Download image and file attachments in parallel (ported from claude-code attachment handling)
    const [{ images, skipped: skippedImages }, fileAttachments] = await Promise.all([
      downloadSlackImages(params.files, botToken),
      downloadSlackFiles(params.files, botToken),
    ]);
    const filePrefix = formatFileAttachments(fileAttachments);
    // Notify user about skipped images so they know why their attachment wasn't processed
    const skippedNotice = skippedImages.length > 0
      ? `[Note: ${skippedImages.length} image(s) skipped — ${skippedImages.join("; ")}]\n`
      : "";
    const messageWithFiles = filePrefix || skippedNotice ? `${skippedNotice}${filePrefix}\n---\n${text}` : text;

    const onToolStart = (toolNames: string[]) => {
      if (!placeholderTs) return;
      const label = toolNames.length === 1 ? toolNames[0] : toolNames.join(", ");
      client.chat.update({ channel, ts: placeholderTs, text: `:gear: Running ${label}...` }).catch((err: unknown) => console.debug("[slack] Tool status update failed:", errMsg(err)));
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
    try {
      // Don't expose raw error details (API keys, paths) to Slack users
      await client.chat.postMessage({
        channel,
        text: "Sorry, something went wrong processing your message. Please try again.",
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

const mentionRegexCache = new Map<string, RegExp>();
function stripMention(text: string, botUserId: string): string {
  let re = mentionRegexCache.get(botUserId);
  if (!re) {
    re = new RegExp(`<@${botUserId}>`, "g");
    mentionRegexCache.set(botUserId, re);
  }
  re.lastIndex = 0; // reset stateful global regex
  return text.replace(re, "").trim();
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
