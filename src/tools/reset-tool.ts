import type { ToolDefinition, ToolUseContext } from "../types.js";
import { getStudentsForTutor, getRegisteredAgent } from "../relay.js";

/**
 * Reset tool for tutors — clear a student agent's conversation session.
 * Useful when a student is stuck in a loop or the conversation context is corrupted.
 */
export function createResetTool(): ToolDefinition {
  return {
    name: "reset_session",
    description:
      "Clear a student agent's conversation sessions. Use when a student is stuck or context is corrupted.",
    parameters: {
      type: "object",
      properties: {
        studentAgentId: {
          type: "string",
          description: "The student agent ID to reset.",
        },
        sessionKey: {
          type: "string",
          description: "Specific session key to clear. Omit to clear all sessions for this student.",
        },
      },
      required: ["studentAgentId"],
    },
    isReadOnly: false,
    category: "utility",

    async execute(input: Record<string, unknown>, context?: ToolUseContext): Promise<string> {
      const tutorId = context?.agentId ?? "unknown";
      const studentId = (input.studentAgentId as string)?.trim();
      if (!studentId) return "Error: studentAgentId is required.";
      const sessionKey = input.sessionKey as string | undefined;

      // Verify this student belongs to this tutor
      const students = getStudentsForTutor(tutorId);
      if (!students.some((s) => s.id === studentId)) {
        return `Error: "${studentId}" is not linked to you. Your students: ${students.map((s) => s.id).join(", ") || "(none)"}`;
      }

      const reg = getRegisteredAgent(studentId);
      if (!reg) return `Error: agent "${studentId}" not found in registry.`;

      if (sessionKey) {
        // Clear specific session
        if (!reg.sessions.has(sessionKey)) {
          return `No active session with key "${sessionKey}" for ${studentId}.`;
        }
        // Get session and clear its messages
        const session = reg.sessions.get(sessionKey);
        const msgCount = session.messages.length;
        session.messages.length = 0;
        reg.sessions.persistSession(sessionKey);
        return `Cleared session "${sessionKey}" for ${studentId} (${msgCount} messages removed).`;
      }

      if (reg.sessions.size === 0) return `No active sessions for ${studentId}.`;
      const { sessions: count, messages: totalMsgs } = reg.sessions.clearAll();
      return `Cleared ${count} session(s) for ${studentId} (${totalMsgs} messages removed).`;
    },
  };
}
