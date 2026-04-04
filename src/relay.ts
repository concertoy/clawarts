/**
 * Cross-agent relay: allows one agent to send a message through another agent.
 * The target agent processes the message via its own AI loop and delivers the
 * response to the specified Slack channel using its own bot token.
 *
 * Simplified from OpenClaw's sessions_send + agent-step pattern.
 */
import type { WebClient } from "@slack/web-api";
import type { Agent } from "./agent.js";
import type { SessionStore } from "./session.js";
import type { ToolDefinition, ToolUseContext } from "./types.js";
import { BoundedMap } from "./utils/bounded-map.js";
import { errMsg } from "./utils/errors.js";
import { openDmChannel } from "./utils/slack-dm.js";
import { markdownToSlack } from "./utils/slack-markdown.js";

// ─── Agent Registry ─────────────────────────────────────────────────

export interface RegisteredAgent {
  id: string;
  agent: Agent;
  sessions: SessionStore;
  slackClient: WebClient;
  linkedTutor?: string;
  allowedUsers?: string[];
}

const BROADCAST_CONCURRENCY = 5;
const BROADCAST_DEDUP_MS = 10_000; // 10s window to prevent accidental double-broadcast

const registry = new Map<string, RegisteredAgent>();
const lastActiveAt = new Map<string, number>(); // agent ID → epoch ms
const recentBroadcasts = new BoundedMap<string, number>(100); // hash → timestamp

export function registerAgent(entry: RegisteredAgent): void {
  registry.set(entry.id, entry);
}

export function getRegisteredAgent(id: string): RegisteredAgent | undefined {
  return registry.get(id);
}

export function listRegisteredAgentIds(): string[] {
  return [...registry.keys()];
}

/** Mark an agent as active (called from agent loop after each reply). */
export function touchAgent(agentId: string): void {
  lastActiveAt.set(agentId, Date.now());
}

/** Get last-active timestamp for an agent. */
export function getAgentLastActive(agentId: string): number | undefined {
  return lastActiveAt.get(agentId);
}

/** Find all student agents linked to a given tutor, with their allowed users. */
export function getStudentsForTutor(tutorId: string): { id: string; allowedUsers: string[] }[] {
  const students: { id: string; allowedUsers: string[] }[] = [];
  for (const entry of registry.values()) {
    if (entry.linkedTutor === tutorId) {
      students.push({ id: entry.id, allowedUsers: entry.allowedUsers ?? [] });
    }
  }
  return students;
}

// ─── Relay Tool ─────────────────────────────────────────────────────

/**
 * Create a tool that lists student agents linked to this tutor.
 */
export function createListStudentsTool(): ToolDefinition {
  return {
    name: "list_students",
    description:
      "List all student agents linked to you, including their agent IDs and Slack user IDs. Use this to discover which students you manage before relaying messages.",
    parameters: { type: "object", properties: {} },
    isReadOnly: true,
    category: "communication",
    async execute(_input: Record<string, unknown>, context?: ToolUseContext): Promise<string> {
      const tutorId = context?.agentId ?? "unknown";
      const students = getStudentsForTutor(tutorId);
      if (students.length === 0) {
        return `No student agents linked to "${tutorId}".`;
      }
      const lines = students.map((s) => {
        const users = s.allowedUsers.length > 0 ? s.allowedUsers.map((u) => `<@${u}>`).join(", ") : "(none)";
        const active = getAgentLastActive(s.id);
        const ago = active ? `${Math.round((Date.now() - active) / 60_000)}m ago` : "never";
        return `• ${s.id}: users ${users} (last active: ${ago})`;
      });
      return `Students linked to ${tutorId}:\n${lines.join("\n")}`;
    },
  };
}

// ─── Relay Helper ──────────────────────────────────────────────────

/** Relay a message to a single student agent → user DM. */
async function relayToStudent(
  targetId: string,
  userId: string,
  message: string,
  sourceAgent: string,
): Promise<string> {
  const target = getRegisteredAgent(targetId);
  if (!target) {
    throw new Error(`Agent "${targetId}" not found.`);
  }

  const channelId = await openDmChannel(target.slackClient, userId);

  const sessionKey = `relay:${sourceAgent}:${targetId}:${userId}`;
  const reply = await target.agent.getReply(
    sessionKey,
    `[Relayed from agent "${sourceAgent}"]\n${message}`,
    "system",
    { channelId },
  );

  await target.slackClient.chat.postMessage({
    channel: channelId,
    text: markdownToSlack(reply),
  });

  return `${targetId}/<@${userId}>: ${reply.length} chars`;
}

/**
 * Create a relay tool scoped to a specific source agent.
 * Only agents with linked students (tutors) get this tool.
 *
 * Actions:
 * - send: relay to a single student (requires targetAgentId + userId)
 * - broadcast: relay to ALL linked students in parallel (one tool call)
 */
export function createRelayTool(): ToolDefinition {
  return {
    name: "relay",
    description:
      "Send a message through student agent(s). Actions: send (one student, requires targetAgentId + userId), broadcast (all linked students in parallel — one call reaches everyone).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["send", "broadcast"],
          description: "send = one student, broadcast = all linked students. Default: send.",
        },
        targetAgentId: {
          type: "string",
          description: "The ID of the agent to relay through (for send action).",
        },
        userId: {
          type: "string",
          description: "The Slack user ID to DM (for send action). The relay opens the DM channel automatically.",
        },
        message: {
          type: "string",
          description: "The message to send. The target agent(s) will process this and generate their own response.",
        },
      },
      required: ["message"],
    },
    isReadOnly: false,
    category: "communication",
    async execute(input: Record<string, unknown>, context?: ToolUseContext): Promise<string> {
      const action = (input.action as string) || "send";
      const message = (input.message as string)?.trim();
      if (!message) return "[Error] message is required.";

      const sourceAgent = context?.agentId ?? "unknown";

      if (action === "broadcast") {
        const students = getStudentsForTutor(sourceAgent);
        if (students.length === 0) return `No student agents linked to "${sourceAgent}".`;

        // Dedup: prevent accidental double-broadcast of the same message
        const dedupKey = `${sourceAgent}:${message.slice(0, 100)}`;
        const lastSent = recentBroadcasts.get(dedupKey);
        if (lastSent && Date.now() - lastSent < BROADCAST_DEDUP_MS) {
          return `Broadcast skipped — same message was sent ${Math.round((Date.now() - lastSent) / 1000)}s ago. Wait ${Math.ceil(BROADCAST_DEDUP_MS / 1000)}s to re-send.`;
        }
        recentBroadcasts.set(dedupKey, Date.now());
        // Expire stale entries (older than 2x dedup window)
        for (const [k, t] of recentBroadcasts) {
          if (Date.now() - t > BROADCAST_DEDUP_MS * 2) recentBroadcasts.delete(k);
        }

        // Fan out with bounded concurrency (5 at a time) to prevent resource spikes
        const pairs = students.flatMap((s) =>
          s.allowedUsers.map((uid) => ({ agentId: s.id, uid })),
        );
        const results = await boundedParallel(
          pairs,
          (p) => relayToStudent(p.agentId, p.uid, message, sourceAgent),
          BROADCAST_CONCURRENCY,
        );
        const ok = results.filter((r) => r.status === "fulfilled");
        const fail = results.filter((r) => r.status === "rejected");

        const summary = [`Broadcast complete: ${ok.length} delivered, ${fail.length} failed.`];
        for (const f of fail) {
          if (f.status === "rejected") summary.push(`  ✗ ${f.reason}`);
        }
        return summary.join("\n");
      }

      // Default: send to one student
      const targetId = input.targetAgentId as string;
      const userId = input.userId as string;
      if (!targetId || !userId) {
        return "[Error] send action requires targetAgentId and userId. Use action=broadcast to reach all students.";
      }

      const target = getRegisteredAgent(targetId);
      if (!target) {
        const available = listRegisteredAgentIds().join(", ");
        return `[Error] Agent "${targetId}" not found. Available agents: ${available}`;
      }

      try {
        const result = await relayToStudent(targetId, userId, message, sourceAgent);
        return `Relayed: ${result}`;
      } catch (err) {
        const errText = errMsg(err);
        return `[Error] Relay to "${targetId}" failed: ${errText}`;
      }
    },
  };
}

// ─── Bounded concurrency ──────────────────────────────────────────────

/** Run tasks with at most `limit` concurrent executions. Returns PromiseSettledResult[]. */
async function boundedParallel<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
