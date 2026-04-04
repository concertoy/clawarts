import type { ToolDefinition, ToolUseContext } from "../types.js";
import type { AssignmentStore } from "../store/assignment-store.js";
import type { SubmissionStore } from "../store/submission-store.js";
import type { CheckinStore } from "../store/checkin-store.js";
import { getStudentsForTutor } from "../relay.js";

/**
 * Grades export tool for tutors — aggregates assignment and check-in scores
 * into a plain-text table. Copy-paste into a spreadsheet.
 */
export function createGradesTool(
  assignmentStore: AssignmentStore,
  submissionStore: SubmissionStore,
  checkinStore: CheckinStore,
): ToolDefinition {
  return {
    name: "grades",
    description:
      "Export a grade summary table for all students. Includes assignment submissions and check-in scores.",
    parameters: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["table", "csv"],
          description: "Output format: table (human-readable) or csv. Default: table.",
        },
      },
    },
    isReadOnly: true,
    category: "academic",

    async execute(input: Record<string, unknown>, context?: ToolUseContext): Promise<string> {
      const tutorId = context?.agentId ?? "unknown";
      const format = (input.format as string) || "table";

      const students = getStudentsForTutor(tutorId);
      const allUserIds = students.flatMap((s) => s.allowedUsers);
      if (allUserIds.length === 0) return "No students linked.";

      // Gather assignments
      const assignments = await assignmentStore.list({});

      // Gather check-in windows (closed only)
      const allWindows = await checkinStore.listWindows();
      const closedWindows = allWindows.filter((w) => w.status === "closed" && !w.pulseGroupId);

      // Build header
      const assignmentHeaders = assignments.map((a) => a.title.slice(0, 20));
      const checkinHeaders = closedWindows.map((w, i) => `CI-${i + 1}`);
      const headers = ["Student", ...assignmentHeaders, ...checkinHeaders];

      // Build rows
      const rows: string[][] = [];
      for (const uid of allUserIds) {
        const row: string[] = [`<@${uid}>`];

        // Assignment submissions
        for (const a of assignments) {
          const sub = await submissionStore.getByAssignmentAndUser(a.id, uid);
          row.push(sub ? sub.status : "missing");
        }

        // Check-in scores
        for (const w of closedWindows) {
          const responses = await checkinStore.getResponsesByWindow(w.id);
          const resp = responses.find((r) => r.userId === uid);
          if (!resp) {
            row.push("absent");
          } else if (resp.score != null) {
            row.push(String(resp.score));
          } else {
            row.push("pending");
          }
        }

        rows.push(row);
      }

      if (format === "csv") {
        const csvLines = [headers.join(","), ...rows.map((r) => r.join(","))];
        return csvLines.join("\n");
      }

      // Table format
      const colWidths = headers.map((h, i) => {
        const maxData = Math.max(...rows.map((r) => (r[i] ?? "").length));
        return Math.max(h.length, maxData, 6);
      });

      const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join(" | ");
      const separator = colWidths.map((w) => "-".repeat(w)).join("-+-");
      const dataLines = rows.map((r) =>
        r.map((cell, i) => cell.padEnd(colWidths[i])).join(" | "),
      );

      return [
        `Grade Summary (${allUserIds.length} students, ${assignments.length} assignments, ${closedWindows.length} check-ins):`,
        "",
        headerLine,
        separator,
        ...dataLines,
      ].join("\n");
    },
  };
}
