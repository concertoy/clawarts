import type { ToolDefinition, ToolUseContext } from "../types.js";
import type { AssignmentStore } from "../store/assignment-store.js";
import type { SubmissionStore } from "../store/submission-store.js";
import type { Assignment } from "../store/types.js";
import type { CronService } from "../cron/service.js";
import { getStudentsForTutor } from "../relay.js";

/**
 * Assignment management tool for tutor agents.
 * Actions: create, list, get, close, extend.
 */
export function createAssignmentTool(
  assignmentStore: AssignmentStore,
  submissionStore: SubmissionStore,
  cronService: CronService,
  agentId: string,
): ToolDefinition {
  return {
    name: "assignment",
    description:
      "Manage homework assignments. Actions: create (new assignment), list (show all), get (details + submissions), close (stop accepting), extend (change deadline).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "get", "close", "extend"],
          description: "The action to perform.",
        },
        // create fields
        title: { type: "string", description: "Assignment title." },
        description: { type: "string", description: "Assignment description / instructions." },
        deadline: { type: "string", description: "Deadline as ISO 8601 string (e.g. '2026-04-10T23:59:00Z')." },
        format: { type: "string", enum: ["individual", "group"], description: "Submission format. Default: individual." },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: "URLs or file paths for reference materials.",
        },
        // get/close/extend fields
        assignmentId: { type: "string", description: "Assignment ID (for get, close, extend)." },
        // extend fields
        newDeadline: { type: "string", description: "New deadline as ISO 8601 string (for extend action)." },
      },
      required: ["action"],
    },
    isReadOnly: false,
    category: "academic",

    async execute(input: Record<string, unknown>, context?: ToolUseContext): Promise<string> {
      const action = input.action as string;

      switch (action) {
        case "create": {
          const title = input.title as string;
          const description = input.description as string;
          const deadlineStr = input.deadline as string;
          if (!title || !description || !deadlineStr) {
            return "Error: title, description, and deadline are required.";
          }

          const deadline = new Date(deadlineStr).getTime();
          if (!deadline || isNaN(deadline)) return "Error: invalid deadline format. Use ISO 8601 (e.g. '2026-04-10T23:59:00Z').";
          if (deadline <= Date.now()) return "Error: deadline must be in the future.";

          const assignment = await assignmentStore.create({
            title,
            description,
            deadline,
            format: input.format === "group" ? "group" : "individual",
            attachments: (input.attachments as string[]) || [],
            status: "open",
            createdBy: agentId,
          });

          const channelId = context?.channelId || "";
          if (channelId) {
            // Auto-schedule a reminder 24h before deadline
            const reminderTime = deadline - 24 * 60 * 60 * 1000;
            if (reminderTime > Date.now()) {
              await cronService.add({
                name: `Reminder: ${title}`,
                message: `⏰ Assignment "${title}" is due in 24 hours! Deadline: ${new Date(deadline).toISOString()}`,
                channelId,
                agentId,
                schedule: { kind: "at", atMs: reminderTime },
                enabled: true,
              });
            }

            // Auto-close at deadline
            await cronService.add({
              name: `Auto-close: ${title}`,
              message: `[SYSTEM:CLOSE_ASSIGNMENT] assignmentId=${assignment.id}`,
              channelId,
              agentId,
              schedule: { kind: "at", atMs: deadline },
              enabled: true,
            });
          }

          return [
            `Assignment created:`,
            `- ID: ${assignment.id}`,
            `- Title: ${assignment.title}`,
            `- Deadline: ${new Date(deadline).toISOString()}`,
            `- Format: ${assignment.format}`,
            `- Attachments: ${assignment.attachments.length > 0 ? assignment.attachments.join(", ") : "none"}`,
            ``,
            `Use the relay tool to announce this to students.`,
          ].join("\n");
        }

        case "list": {
          const statusFilter = input.status as Assignment["status"] | undefined;
          const assignments = await assignmentStore.list(statusFilter ? { status: statusFilter } : undefined);
          if (assignments.length === 0) return "No assignments found.";

          const lines = await Promise.all(
            assignments.map(async (a) => {
              const subs = await submissionStore.listByAssignment(a.id);
              const deadlineStr = new Date(a.deadline).toISOString();
              const overdue = a.status === "open" && Date.now() > a.deadline ? " (OVERDUE)" : "";
              return `- [${a.status}] "${a.title}" (${a.id})\n  Deadline: ${deadlineStr}${overdue}\n  Submissions: ${subs.length}`;
            }),
          );
          return `Assignments (${assignments.length}):\n\n${lines.join("\n\n")}`;
        }

        case "get": {
          const id = input.assignmentId as string;
          if (!id) return "Error: assignmentId is required.";

          const assignment = await assignmentStore.get(id);
          if (!assignment) return `No assignment found with ID ${id}.`;

          const submissions = await submissionStore.listByAssignment(id);
          const students = getStudentsForTutor(agentId);
          const allUserIds = students.flatMap((s) => s.allowedUsers);
          const submittedUserIds = new Set(submissions.map((s) => s.userId));
          const missing = allUserIds.filter((u) => !submittedUserIds.has(u));

          const subLines = submissions.map(
            (s) => `  - <@${s.userId}> [${s.status}] at ${new Date(s.submittedAt).toISOString()}: ${s.content.slice(0, 200)}`,
          );

          return [
            `Assignment: "${assignment.title}"`,
            `ID: ${assignment.id}`,
            `Status: ${assignment.status}`,
            `Deadline: ${new Date(assignment.deadline).toISOString()}`,
            `Format: ${assignment.format}`,
            `Description: ${assignment.description}`,
            assignment.attachments.length > 0 ? `Attachments: ${assignment.attachments.join(", ")}` : "",
            ``,
            `Submissions (${submissions.length}):`,
            subLines.length > 0 ? subLines.join("\n") : "  (none)",
            missing.length > 0 ? `\nNot submitted: ${missing.map((u) => `<@${u}>`).join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        }

        case "close": {
          const id = input.assignmentId as string;
          if (!id) return "Error: assignmentId is required.";

          const assignment = await assignmentStore.close(id);
          if (!assignment) return `No assignment found with ID ${id}.`;
          return `Assignment "${assignment.title}" closed. No more submissions accepted.`;
        }

        case "extend": {
          const id = input.assignmentId as string;
          const newDeadlineStr = input.newDeadline as string;
          if (!id || !newDeadlineStr) return "Error: assignmentId and newDeadline are required.";

          const newDeadline = new Date(newDeadlineStr).getTime();
          if (!newDeadline || isNaN(newDeadline)) return "Error: invalid newDeadline format.";
          if (newDeadline <= Date.now()) return "Error: new deadline must be in the future.";

          const existing = await assignmentStore.get(id);
          if (!existing) return `No assignment found with ID ${id}.`;
          if (existing.status === "closed") return "Error: cannot extend a closed assignment. Reopen it first.";
          if (existing.deadline && newDeadline <= existing.deadline) {
            return `Error: new deadline must be after current deadline (${new Date(existing.deadline).toISOString()}).`;
          }

          const assignment = await assignmentStore.update(id, { deadline: newDeadline });
          if (!assignment) return `No assignment found with ID ${id}.`;
          return `Deadline extended to ${new Date(newDeadline).toISOString()} for "${assignment.title}".`;
        }

        default:
          return `Unknown action: ${action}. Use create, list, get, close, or extend.`;
      }
    },
  };
}
