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

const registry = new Map<string, RegisteredAgent>();

export function registerAgent(entry: RegisteredAgent): void {
  registry.set(entry.id, entry);
}

export function getRegisteredAgent(id: string): RegisteredAgent | undefined {
  return registry.get(id);
}

export function listRegisteredAgentIds(): string[] {
  return [...registry.keys()];
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
    category: "utility",
    async execute(_input: Record<string, unknown>, context?: ToolUseContext): Promise<string> {
      const tutorId = context?.agentId ?? "unknown";
      const students = getStudentsForTutor(tutorId);
      if (students.length === 0) {
        return `No student agents linked to "${tutorId}".`;
      }
      const lines = students.map(
        (s) => `• ${s.id}: users ${s.allowedUsers.length > 0 ? s.allowedUsers.map((u) => `<@${u}>`).join(", ") : "(none)"}`,
      );
      return `Students linked to ${tutorId}:\n${lines.join("\n")}`;
    },
  };
}

/**
 * Create a relay tool scoped to a specific source agent.
 * Only agents with linked students (tutors) get this tool.
 */
export function createRelayTool(): ToolDefinition {
  return {
    name: "relay",
    description:
      "Send a message through another agent. The target agent processes it via its own AI and posts the response to the specified Slack channel. Use this to relay announcements or tasks to student agents.",
    parameters: {
      type: "object",
      properties: {
        targetAgentId: {
          type: "string",
          description: "The ID of the agent to relay through (e.g. 'student-1').",
        },
        userId: {
          type: "string",
          description: "The Slack user ID of the person the target agent should DM (e.g. 'U07ERPSNP6X'). The relay will open/find the DM channel automatically.",
        },
        message: {
          type: "string",
          description: "The message to send to the target agent. It will process this and generate its own response.",
        },
      },
      required: ["targetAgentId", "userId", "message"],
    },
    isReadOnly: false,
    category: "utility",
    async execute(input: Record<string, unknown>, context?: ToolUseContext): Promise<string> {
      const targetId = input.targetAgentId as string;
      const userId = input.userId as string;
      const message = input.message as string;

      if (!targetId || !userId || !message) {
        return "[Error] Missing required fields: targetAgentId, userId, message.";
      }

      const target = getRegisteredAgent(targetId);
      if (!target) {
        const available = listRegisteredAgentIds().join(", ");
        return `[Error] Agent "${targetId}" not found. Available agents: ${available}`;
      }

      const sourceAgent = context?.agentId ?? "unknown";

      try {
        // Open/find the DM channel between the target agent's bot and the user
        const dmResp = await target.slackClient.conversations.open({ users: userId });
        const channelId = dmResp.channel?.id;
        if (!channelId) {
          return `[Error] Could not open DM channel with user ${userId} via ${targetId}'s bot.`;
        }

        // Derive a session key for this relay conversation
        const sessionKey = `relay:${sourceAgent}:${channelId}`;

        // Run the target agent's AI loop with the relayed message
        const reply = await target.agent.getReply(
          sessionKey,
          `[Relayed from agent "${sourceAgent}"]\n${message}`,
          "system",
          { channelId },
        );

        // Post the response via the target agent's Slack client
        await target.slackClient.chat.postMessage({
          channel: channelId,
          text: markdownToSlack(reply),
        });

        return `Relayed to ${targetId}. Response (${reply.length} chars) posted to DM with <@${userId}>.`;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return `[Error] Relay to "${targetId}" failed: ${errMsg}`;
      }
    },
  };
}
