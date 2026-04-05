import type { WebClient } from "@slack/web-api";
import { BoundedMap } from "./bounded-map.js";

// Cache DM channel IDs to avoid repeated API calls.
// Key: "botToken:userId" to handle multi-agent setups where
// different bots may have different DM channels with the same user.
const dmCache = new BoundedMap<string, string>(500);

/**
 * Open a DM channel with a user and return the channel ID.
 * Results are cached to avoid repeated conversations.open API calls.
 */
export async function openDmChannel(client: WebClient, userId: string): Promise<string> {
  // Use the client's token prefix as part of the cache key
  // to differentiate between different bot tokens in multi-agent setups.
  // Guard against null/undefined tokens — use full token hash to avoid prefix collisions.
  const token = client.token;
  if (!token) throw new Error("WebClient has no token — cannot open DM channel");
  const tokenKey = token.slice(0, 10);
  const cacheKey = `${tokenKey}:${userId}`;
  const cached = dmCache.get(cacheKey);
  if (cached) return cached;

  const resp = await client.conversations.open({ users: userId });
  if (!resp.ok) {
    throw new Error(`Slack API error opening DM with ${userId}: ${resp.error ?? "unknown"}`);
  }
  const channelId = resp.channel?.id;
  if (!channelId) {
    throw new Error(`Could not open DM channel with user ${userId}.`);
  }

  dmCache.set(cacheKey, channelId);
  return channelId;
}
