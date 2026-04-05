import type { ToolDefinition, ToolUseContext } from "../types.js";
import type { AssignmentStore } from "../store/assignment-store.js";
import type { SubmissionStore } from "../store/submission-store.js";
import { getRegisteredAgent } from "../relay.js";
import { errMsg } from "../utils/errors.js";
import { openDmChannel } from "../utils/slack-dm.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("submit");

/**
 * Submission tool for student agents.
 * Actions: submit, list, view.
 */
export function createSubmitTool(
  assignmentStore: AssignmentStore,
  submissionStore: SubmissionStore,
): ToolDefinition {
  return {
    name: "submit",
    description:
      "Manage assignment submissions. Actions: submit (turn in work), list (your submissions), view (assignment details).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["submit", "list", "view"],
          description: "The action to perform.",
        },
        assignmentId: { type: "string", description: "Assignment ID (for submit and view)." },
        content: { type: "string", description: "Submission content — text answer or file path (for submit action)." },
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
        case "submit": {
          const assignmentId = input.assignmentId as string;
          const content = input.content as string;
          if (!assignmentId || !content) return "Error: assignmentId and content are required.";
          if (content.length > 50_000) return `Error: submission content too long (${Math.round(content.length / 1000)}K chars, max 50K).`;

          const assignment = await assignmentStore.get(assignmentId);
          if (!assignment) return `Error: assignment ${assignmentId} not found.`;
          if (assignment.status === "closed") return `Error: assignment "${assignment.title}" is closed and no longer accepts submissions.`;

          const existing = await submissionStore.getByAssignmentAndUser(assignmentId, userId);
          const submission = await submissionStore.submit(
            { assignmentId, userId, agentId, content },
            assignment.deadline,
          );

          const lateNote = submission.status === "late" ? " (LATE — past deadline)" : "";
          const resubNote = existing ? " (previous submission overwritten)" : "";

          // Notify tutor of new submission (best-effort, fire-and-forget)
          notifyTutorOfSubmission(agentId, userId, assignment.title, submission.status === "late")
            .catch((err) => log.warn("Failed to notify tutor:", errMsg(err)));

          const receipt = [
            `Submitted${lateNote}${resubNote}:`,
            `- Assignment: "${assignment.title}"`,
            `- Submission ID: ${submission.id}`,
            `- Time: ${new Date(submission.submittedAt).toISOString()}`,
            submission.status === "late"
              ? `\nNote: This submission was received after the deadline (${new Date(assignment.deadline).toISOString()}).`
              : "",
          ].filter(Boolean).join("\n");

          return receipt;
        }

        case "list": {
          const submissions = await submissionStore.listByUser(userId);
          if (submissions.length === 0) return "You have no submissions yet.";

          const lines = await Promise.all(
            submissions.map(async (s) => {
              const assignment = await assignmentStore.get(s.assignmentId);
              const title = assignment?.title ?? s.assignmentId;
              const grade = s.score != null ? ` — score: ${s.score}/100` : "";
              const fb = s.feedback ? ` ("${s.feedback}")` : "";
              return `- "${title}" [${s.status}]${grade}${fb} — submitted ${new Date(s.submittedAt).toISOString()}`;
            }),
          );
          return `Your submissions (${submissions.length}):\n${lines.join("\n")}`;
        }

        case "view": {
          const assignmentId = input.assignmentId as string;
          if (!assignmentId) {
            // List all open assignments
            const assignments = await assignmentStore.list({ status: "open" });
            if (assignments.length === 0) return "No open assignments.";

            const lines = await Promise.all(
              assignments.map(async (a) => {
                const sub = await submissionStore.getByAssignmentAndUser(a.id, userId);
                const subStatus = sub ? `✓ submitted (${sub.status})` : "✗ not submitted";
                return `- "${a.title}" (${a.id})\n  Deadline: ${new Date(a.deadline).toISOString()}\n  Status: ${subStatus}`;
              }),
            );
            return `Open assignments (${assignments.length}):\n\n${lines.join("\n\n")}`;
          }

          const assignment = await assignmentStore.get(assignmentId);
          if (!assignment) return `Assignment ${assignmentId} not found.`;

          const sub = await submissionStore.getByAssignmentAndUser(assignmentId, userId);
          return [
            `Assignment: "${assignment.title}"`,
            `ID: ${assignment.id}`,
            `Status: ${assignment.status}`,
            `Deadline: ${new Date(assignment.deadline).toISOString()}`,
            `Format: ${assignment.format}`,
            `Description: ${assignment.description}`,
            assignment.attachments.length > 0 ? `Attachments: ${assignment.attachments.join(", ")}` : "",
            ``,
            sub
              ? `Your submission: [${sub.status}] at ${new Date(sub.submittedAt).toISOString()}${sub.score != null ? `\nGrade: ${sub.score}/100${sub.feedback ? ` — "${sub.feedback}"` : ""}` : ""}`
              : "You have not submitted yet.",
          ]
            .filter(Boolean)
            .join("\n");
        }

        default:
          return `Unknown action: ${action}. Use submit, list, or view.`;
      }
    },
  };
}

/** DM the tutor about a new submission. Best-effort, no AI loop. */
async function notifyTutorOfSubmission(
  studentAgentId: string,
  userId: string,
  assignmentTitle: string,
  isLate: boolean,
): Promise<void> {
  const studentAgent = getRegisteredAgent(studentAgentId);
  if (!studentAgent?.linkedTutor) return;

  const tutor = getRegisteredAgent(studentAgent.linkedTutor);
  if (!tutor) return;

  // Find a tutor user to DM (first allowed user)
  const tutorUserId = tutor.allowedUsers?.[0];
  if (!tutorUserId) return;

  const channelId = await openDmChannel(tutor.slackClient, tutorUserId);

  const lateTag = isLate ? " _(late)_" : "";
  await tutor.slackClient.chat.postMessage({
    channel: channelId,
    text: `\u{1f4e5} <@${userId}> submitted "${assignmentTitle}"${lateTag}`,
  });
}
