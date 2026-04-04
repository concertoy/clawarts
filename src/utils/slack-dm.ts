import type { WebClient } from "@slack/web-api";

/**
 * Open a DM channel with a user and return the channel ID.
 * Wraps the conversations.open → channel.id pattern with proper error handling.
 */
export async function openDmChannel(client: WebClient, userId: string): Promise<string> {
  const resp = await client.conversations.open({ users: userId });
  if (!resp.ok) {
    throw new Error(`Slack API error opening DM with ${userId}: ${resp.error ?? "unknown"}`);
  }
  const channelId = resp.channel?.id;
  if (!channelId) {
    throw new Error(`Could not open DM channel with user ${userId}.`);
  }
  return channelId;
}
