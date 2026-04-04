/**
 * Session hydration from Slack API — fetch conversation history on cold sessions.
 * Extracted from slack.ts for readability.
 */
import type { WebClient } from "@slack/web-api";
import type { SessionStore } from "../session.js";
import { errMsg } from "./errors.js";

const HISTORY_LIMIT = 20;

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
export async function hydrateFromDM(
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

    const count = ingestMessages(sessions, sessionKey, [...messages].reverse(), botUserId);
    if (count > 0) {
      console.debug(`[slack] Hydrated ${count} messages from DM history (${sessionKey})`);
    }
  } catch (err) {
    console.warn(`[slack] Failed to fetch DM history (${sessionKey}):`, errMsg(err));
  }
}

/**
 * Fetch thread replies via conversations.replies().
 * Called on cold session for channel threads.
 */
export async function hydrateFromThread(
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
      console.debug(`[slack] Hydrated ${count} messages from thread history (${sessionKey})`);
    }
  } catch (err) {
    console.warn(`[slack] Failed to fetch thread history (${sessionKey}):`, errMsg(err));
  }
}
