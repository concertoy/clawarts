import type { ToolDefinition, ToolUseContext } from "../types.js";
import type { AssignmentStore } from "../store/assignment-store.js";
import type { SubmissionStore } from "../store/submission-store.js";
import type { CheckinStore } from "../store/checkin-store.js";

/**
 * Student self-service status tool — shows their own deadlines, submissions, and scores.
 */
export function createMyStatusTool(
  assignmentStore: AssignmentStore,
  submissionStore: SubmissionStore,
  checkinStore: CheckinStore,
): ToolDefinition {
  return {
    name: "my_status",
    description:
      "Show your current status: upcoming deadlines, submission history, and check-in scores.",
    parameters: { type: "object", properties: {} },
    isReadOnly: true,
    category: "academic",

    async execute(_input: Record<string, unknown>, context?: ToolUseContext): Promise<string> {
      const userId = context?.userId ?? "unknown";
      const lines: string[] = ["Your status:"];

      // Open assignments + submission status
      const assignments = await assignmentStore.list({ status: "open" });
      if (assignments.length > 0) {
        lines.push(`\nAssignments (${assignments.length} open):`);
        for (const a of assignments) {
          const sub = await submissionStore.getByAssignmentAndUser(a.id, userId);
          const deadline = new Date(a.deadline).toISOString();
          const overdue = Date.now() > a.deadline ? " (OVERDUE)" : "";
          let status: string;
          if (!sub) {
            status = "not submitted";
          } else if (sub.score != null) {
            status = `${sub.score}/100${sub.feedback ? ` — "${sub.feedback}"` : ""}`;
          } else {
            status = `submitted (${sub.status})`;
          }
          lines.push(`  "${a.title}" — due ${deadline}${overdue} — ${status}`);
        }
      } else {
        lines.push("\nNo open assignments.");
      }

      // Check-in history (last 10)
      const responses = await checkinStore.getResponsesByUser(userId);
      if (responses.length > 0) {
        const recent = responses.slice(-10);
        const scored = responses.filter((r) => r.score != null);
        const avg = scored.length > 0
          ? Math.round(scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length)
          : null;

        lines.push(`\nCheck-ins (${responses.length} total${avg != null ? `, avg: ${avg}/100` : ""}):`);
        for (const r of recent) {
          const window = await checkinStore.getWindow(r.windowId);
          const mode = window?.mode ?? "?";
          const score = r.score != null ? `${r.score}/100` : "pending";
          lines.push(`  ${mode}: ${r.status ?? "pending"} — ${score}`);
        }
      } else {
        lines.push("\nNo check-in history.");
      }

      // Active check-in window
      const active = await checkinStore.getActiveWindow();
      if (active) {
        const remaining = Math.max(0, Math.round((active.closesAt - Date.now()) / 1000));
        const closesStr = new Date(active.closesAt).toISOString();
        lines.push(`\nActive check-in: ${active.mode} — closes at ${closesStr} (${Math.floor(remaining / 60)}m ${remaining % 60}s remaining)`);
      }

      return lines.join("\n");
    },
  };
}
