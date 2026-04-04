import type { ToolDefinition, ToolUseContext } from "../types.js";
import { getStudentsForTutor, getRegisteredAgent } from "../relay.js";
import { getTokenUsage } from "../utils/token-tracker.js";
import { formatTokenCount, formatTimeAgo } from "../utils/format.js";

/**
 * Session export tool for tutors — view a student's recent conversation history.
 * Useful for academic integrity review or debugging student issues.
 */
export function createExportTool(): ToolDefinition {
  return {
    name: "export_session",
    description:
      "Export a student agent's conversation history. Without sessionKey, lists available sessions. With sessionKey, returns the conversation transcript.",
    parameters: {
      type: "object",
      properties: {
        studentAgentId: {
          type: "string",
          description: "The student agent ID to export from.",
        },
        sessionKey: {
          type: "string",
          description: "Specific session key to export. Omit to list available sessions.",
        },
        maxMessages: {
          type: "number",
          description: "Max messages to include (default: 30, max: 50).",
        },
      },
      required: ["studentAgentId"],
    },
    isReadOnly: true,
    category: "utility",

    async execute(input: Record<string, unknown>, context?: ToolUseContext): Promise<string> {
      const tutorId = context?.agentId ?? "unknown";
      const studentId = input.studentAgentId as string;
      const sessionKey = input.sessionKey as string | undefined;
      const maxMessages = Math.min(50, Math.max(1, (input.maxMessages as number) || 30));

      // Verify this student belongs to this tutor
      const students = getStudentsForTutor(tutorId);
      if (!students.some((s) => s.id === studentId)) {
        return `Error: "${studentId}" is not linked to you. Your students: ${students.map((s) => s.id).join(", ") || "(none)"}`;
      }

      const reg = getRegisteredAgent(studentId);
      if (!reg) return `Error: agent "${studentId}" not found in registry.`;

      const sessions = reg.sessions;

      // No sessionKey: list available sessions
      if (!sessionKey) {
        const list = sessions.listSessions();
        if (list.length === 0) return `No active sessions for ${studentId}.`;

        const sorted = list.sort((a, b) => b.updatedAt - a.updatedAt);
        const tokens = getTokenUsage(studentId);
        const tokenInfo = tokens
          ? `\nToken usage: ${formatTokenCount(tokens.inputTokens)} in / ${formatTokenCount(tokens.outputTokens)} out (${tokens.requestCount} req)\n`
          : "";

        const lines = sorted.map((s) => {
          return `  ${s.key}: ${s.messageCount} messages (${formatTimeAgo(s.updatedAt)})`;
        });

        return `Sessions for ${studentId} (${list.length}):${tokenInfo}\n${lines.join("\n")}\n\nUse sessionKey to export a specific conversation.`;
      }

      // Export specific session
      const messages = sessions.getMessages(sessionKey);
      if (messages.length === 0) return `No messages found for session "${sessionKey}".`;

      const recent = messages.slice(-maxMessages);
      const lines = recent.map((m) => {
        const label = m.role === "user" ? "Student" : "Agent";
        const content = m.content.length > 2000 ? m.content.slice(0, 2000) + "..." : m.content;
        return `[${label}]\n${content}`;
      });

      return [
        `Transcript: ${studentId} / ${sessionKey} (${recent.length}/${messages.length} messages):`,
        "",
        lines.join("\n\n---\n\n"),
      ].join("\n");
    },
  };
}
