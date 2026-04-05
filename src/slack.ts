import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { AgentConfig } from "./types.js";
import type { Agent } from "./agent.js";
import { SessionStore } from "./session.js";
import { BoundedMap } from "./utils/bounded-map.js";
import { errMsg, isAbortError } from "./utils/errors.js";
import { markdownToSlack } from "./utils/slack-markdown.js";
import { downloadSlackImages } from "./utils/slack-images.js";
import { downloadSlackFiles, formatFileAttachments } from "./utils/slack-files.js";
import { chunkText, stripMention, sanitizeInput } from "./utils/slack-text.js";
import { hydrateFromDM, hydrateFromThread } from "./utils/slack-hydrate.js";
import type { SlackFile } from "./utils/slack-types.js";
import { KeyedAsyncQueue } from "./queue/keyed-async-queue.js";
import { enqueueCommand } from "./queue/command-queue.js";
import { CommandLane } from "./queue/lanes.js";
import { enqueueFollowup, type FollowupItem } from "./queue/followup-queue.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("slack");

const SLACK_TEXT_LIMIT = 4000;
const STREAM_UPDATE_INTERVAL_MS = 1500;
const SOCKET_PING_TIMEOUT_MS = 30_000;

export function createSlackApp(config: AgentConfig, agent: Agent, sessions: SessionStore): App {
  const alog = createLogger(`slack:${config.id}`);

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
  const botDmChannels = new BoundedMap<string, true>(500); // DM channels confirmed to be with the bot

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
        botDmChannels.set(channel, true);
        return true;
      }
      return false;
    } catch (err) {
      alog.warn(`isBotDM check failed for ${channel}:`, errMsg(err));
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
      if (isAbortError(err)) return;
      alog.error(`Dispatch error for ${params.sessionKey}:`, errMsg(err));
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

  /**
   * Shared hydrate-and-dispatch logic for both app_mention and message handlers.
   * Hydrates cold sessions from Slack API, builds params, and routes to dispatch.
   */
  async function hydrateAndDispatch(opts: {
    client: WebClient;
    channel: string;
    ts: string;
    threadTs: string | undefined;
    text: string;
    userId: string;
    files?: SlackFile[];
    myId: string;
  }): Promise<void> {
    const { client, channel, ts, threadTs, text, userId, files, myId } = opts;
    const sessionKey = SessionStore.deriveKey(channel, ts, threadTs);
    const isDM = channel.startsWith("D");

    // Hydrate from Slack API if session is cold (new or after restart).
    let isNewSession = false;
    if (!sessions.has(sessionKey)) {
      const restored = sessions.get(sessionKey);
      if (restored.messages.length === 0) {
        isNewSession = true;
        if (isDM) {
          await hydrateFromDM(client, sessions, sessionKey, channel, myId);
        } else if (threadTs) {
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
      userId,
      sessionKey,
      botToken: config.slackBotToken,
      files,
      welcomeMessage: config.welcomeMessage,
      isNewSession,
    };

    if (sessionQueue.has(sessionKey)) {
      dispatchFollowup(params);
    } else {
      dispatch(params);
    }
  }

  // Handle direct mentions in channels
  app.event("app_mention", async ({ event, client }) => {
    if (isDuplicate(event.channel, event.ts)) return;
    if (allowedUsers && event.user && !allowedUsers.has(event.user)) return;

    const myId = await resolveBotId(client);
    const text = sanitizeInput(stripMention(event.text, myId));
    if (!text.trim()) return;

    await hydrateAndDispatch({
      client,
      channel: event.channel,
      ts: event.ts,
      threadTs: event.thread_ts ?? event.ts,
      text,
      userId: event.user ?? "unknown",
      files: (event as unknown as { files?: SlackFile[] }).files,
      myId,
    });
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

    if (isDM && !(await isBotDM(client, channel, myId))) return;
    if (!isDM && !isThreadReply) return; // top-level channel — handled by app_mention
    if (!isDM && isThreadReply) {
      const sessionKey = SessionStore.deriveKey(channel, ts, threadTs);
      if (!sessions.has(sessionKey)) return;
    }

    // Dedup AFTER skip checks — otherwise we poison the dedup set for
    // messages this handler skips, blocking the app_mention handler.
    if (isDuplicate(channel, ts)) return;

    const text = sanitizeInput(isDM ? text_raw : stripMention(text_raw, myId));

    await hydrateAndDispatch({
      client,
      channel,
      ts,
      threadTs,
      text,
      userId: user_raw ?? "unknown",
      files: msg.subtype === "message_changed" ? msg.message?.files : msg.files,
      myId,
    });
  });

  // Log Socket Mode connection lifecycle for debugging WiFi/network issues
  try {
    const receiver = (app as unknown as { receiver?: { client?: { on?: (e: string, cb: () => void) => void } } }).receiver;
    if (receiver?.client?.on) {
      receiver.client.on("connected", () => log.info("Socket Mode connected"));
      receiver.client.on("reconnecting", () => log.warn("Socket Mode reconnecting..."));
      receiver.client.on("disconnected", () => log.warn("Socket Mode disconnected"));
    }
  } catch {
    // Bolt internals may change — non-fatal
  }

  return app;
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
  welcomeMessage?: string;
  isNewSession?: boolean;
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
    log.info(`${sessionKey} from ${userId}: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`);

    // Welcome message for new sessions (configurable per agent)
    if (params.isNewSession && params.welcomeMessage) {
      await client.chat.postMessage({
        channel,
        text: markdownToSlack(params.welcomeMessage),
        ...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
      });
    }

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
          void flushEdit().catch((err) => log.debug("Stream edit failed:", errMsg(err)));
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
      client.chat.update({ channel, ts: placeholderTs, text: `:gear: Running ${label}...` }).catch((err: unknown) => log.debug("Tool status update failed:", errMsg(err)));
    };

    const rawReply = await agent.getReply(sessionKey, messageWithFiles, userId, { channelId: channel, threadTs: replyThreadTs }, onText, images.length > 0 ? images : undefined, onToolStart);
    log.info(`Reply (${rawReply.length} chars): ${rawReply.slice(0, 200)}`);

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
    if (isAbortError(err)) {
      log.info(`Request aborted for ${sessionKey} — suppressing error`);
      return;
    }

    log.error("Error handling message:", err);
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
    // Swap thinking indicator for completion indicator
    try {
      await client.reactions.remove({ channel, timestamp: ts, name: "eyes" });
    } catch {
      // May fail if reaction was already removed
    }
    try {
      await client.reactions.add({ channel, timestamp: ts, name: "white_check_mark" });
    } catch {
      // Non-fatal — reaction may already exist or lack permissions
    }
  }
}

