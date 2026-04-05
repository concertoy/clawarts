import type { ToolDefinition, ToolUseContext } from "../types.js";
import type { CheckinStore } from "../store/checkin-store.js";

function formatTimeRemaining(closesAt: number): string {
  const remaining = Math.max(0, Math.round((closesAt - Date.now()) / 1000));
  return `${Math.floor(remaining / 60)}m ${remaining % 60}s`;
}

/**
 * Minimal check-in response tool for student agents.
 * Actions: respond, view.
 *
 * Security: This tool can ONLY append raw responses and read window info.
 * It cannot set scores, modify existing responses, or manage windows.
 */
export function createCheckinRespondTool(
  checkinStore: CheckinStore,
): ToolDefinition {
  return {
    name: "checkin_respond",
    description:
      "Respond to class check-ins. Actions: respond (submit your answer), view (see active check-in window), history (see your past scores).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["respond", "view", "history"],
          description: "The action to perform.",
        },
        content: {
          type: "string",
          description: "Your check-in response text (for respond action).",
        },
      },
      required: ["action"],
    },
    isReadOnly: false,
    category: "academic",

    async execute(input: Record<string, unknown>, context?: ToolUseContext): Promise<string> {
      const action = input.action as string;
      const userId = context?.userId ?? "unknown";
      const agentId = context?.agentId ?? "unknown";

      switch (action) {
        case "respond": {
          const content = input.content as string;
          if (!content) return "Error: content is required.";
          if (content.length > 10_000) return "Error: response too long (max 10,000 characters).";

          const window = await checkinStore.getRespondableWindow();
          if (!window) return "No active check-in window. There may not be a check-in happening right now.";

          const isLate = Date.now() > window.closesAt;
          const result = await checkinStore.addResponse({
            windowId: window.id,
            userId,
            agentId,
            content,
          });

          if ("error" in result) return `Error: ${result.error}`;

          const lateNote = isLate ? " (late — window has closed)" : ` (${formatTimeRemaining(window.closesAt)} remaining)`;
          return `Check-in response submitted!${lateNote}`;
        }

        case "view": {
          const active = await checkinStore.getActiveWindow();
          if (!active) return "No active check-in window right now.";

          const lines = [
            `Active check-in:`,
            `- Mode: ${active.mode}`,
            `- Time remaining: ${formatTimeRemaining(active.closesAt)}`,
          ];

          if (active.topic) {
            lines.push(`- Topic: ${active.topic}`);
          }

          // For quiz mode: show this student's specific challenge
          if (active.mode === "quiz" && active.challenges) {
            const challenge = active.challenges.find((c) => c.userId === userId);
            if (challenge) {
              lines.push(`- Your question: ${challenge.question}`);
            }
          }

          if (active.mode === "reflect") {
            lines.push(`- Prompt: Describe the most important thing you learned today.`);
          }

          if (active.mode === "pulse") {
            lines.push(`- Prompt: Describe what is being discussed right now in class.`);
            if (active.pulseIndex != null && active.pulseTotal != null) {
              lines.push(`- Pulse: ${active.pulseIndex} of ${active.pulseTotal}`);
            }
          }

          if (active.mode === "passphrase") {
            lines.push(`- Enter the passphrase shown in class.`);
          }

          // Check if student already responded
          const existing = await checkinStore.getResponseByWindowAndUser(active.id, userId);
          if (existing) {
            lines.push(`\nYou already responded: "${existing.content.slice(0, 100)}${existing.content.length > 100 ? "..." : ""}"`);
          }

          return lines.join("\n");
        }

        case "history": {
          const responses = await checkinStore.getResponsesByUser(userId);
          if (responses.length === 0) return "You have no check-in history yet.";

          const lines = await Promise.all(
            responses.map(async (r) => {
              const window = await checkinStore.getWindow(r.windowId);
              const mode = window?.mode ?? "unknown";
              const topic = window?.topic ? ` (${window.topic})` : "";
              const scoreStr = r.score != null ? `score: ${r.score}/100` : "not yet scored";
              const statusStr = r.status ?? "pending";
              return `- ${mode}${topic}: ${statusStr} — ${scoreStr}${r.feedback ? ` — "${r.feedback}"` : ""}`;
            }),
          );

          const scored = responses.filter((r) => r.score != null);
          const avg = scored.length > 0
            ? Math.round(scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length)
            : null;

          return [
            `Your check-in history (${responses.length} total):`,
            ...lines,
            avg != null ? `\nAverage score: ${avg}/100` : "",
          ].filter(Boolean).join("\n");
        }

        default:
          return `Unknown action: ${action}. Use respond, view, or history.`;
      }
    },
  };
}
