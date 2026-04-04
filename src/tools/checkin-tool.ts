import crypto from "node:crypto";
import type { ToolDefinition, ToolUseContext } from "../types.js";
import type { CheckinStore } from "../store/checkin-store.js";
import type { CronService } from "../cron/service.js";
import { getStudentsForTutor, getRegisteredAgent } from "../relay.js";
import { markdownToSlack } from "../utils/slack-markdown.js";

/**
 * Check-in management tool for tutor agents.
 * Actions: open, close, evaluate, report.
 *
 * All check-in data lives in tutor's data directory.
 * Students can only submit responses via the separate checkin_respond tool.
 */
export function createCheckinTool(
  checkinStore: CheckinStore,
  cronService: CronService,
  agentId: string,
): ToolDefinition {
  return {
    name: "checkin",
    description:
      "Manage class check-ins. Actions: open (start a check-in window), close (end early), evaluate (score responses), report (show results). Modes: passphrase, quiz, pulse, reflect.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["open", "close", "evaluate", "report"],
          description: "The action to perform.",
        },
        // open fields
        mode: {
          type: "string",
          enum: ["passphrase", "quiz", "pulse", "reflect"],
          description: "Check-in mode (for open action).",
        },
        topic: { type: "string", description: "Topic for quiz/reflect/pulse modes." },
        passphrase: { type: "string", description: "The passphrase code (for passphrase mode). Do NOT include this in relay messages to students." },
        durationMinutes: { type: "number", description: "How long the window stays open (default: 5)." },
        // open - quiz mode
        challenges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              userId: { type: "string" },
              question: { type: "string" },
            },
            required: ["userId", "question"],
          },
          description: "Per-student questions for quiz mode. Generate these before opening.",
        },
        // open - pulse mode
        pulseCount: { type: "number", description: "Number of micro-checks for pulse mode." },
        pulseIntervalMinutes: { type: "number", description: "Minutes between pulse windows." },
        // close/evaluate/report fields
        windowId: { type: "string", description: "Window ID (defaults to most recent)." },
        pulseGroupId: { type: "string", description: "Pulse group ID (for report on full pulse session)." },
        // evaluate fields
        evaluations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              responseId: { type: "string" },
              score: { type: "number" },
              status: { type: "string", enum: ["checked_in", "late", "needs_review"] },
              feedback: { type: "string" },
            },
            required: ["responseId", "score", "status"],
          },
          description: "Evaluation results for each response (for evaluate action).",
        },
        notifyStudents: {
          type: "boolean",
          description: "If true, DM each student their score and feedback after evaluation (default: false).",
        },
      },
      required: ["action"],
    },
    isReadOnly: false,
    category: "academic",

    async execute(input: Record<string, unknown>, context?: ToolUseContext): Promise<string> {
      const action = input.action as string;

      switch (action) {
        case "open": {
          const mode = input.mode as "passphrase" | "quiz" | "pulse" | "reflect";
          if (!mode) return "Error: mode is required (passphrase, quiz, pulse, reflect).";

          const durationMinutes = Math.max(1, Math.min(120, (input.durationMinutes as number) || 5));
          const closesAt = Date.now() + durationMinutes * 60 * 1000;

          if (mode === "pulse") {
            const pulseCount = Math.max(1, Math.min(20, (input.pulseCount as number) || 3));
            const pulseIntervalMinutes = Math.max(1, Math.min(120, (input.pulseIntervalMinutes as number) || 15));
            const topic = input.topic as string;
            const pulseGroupId = crypto.randomUUID();

            const windows = [];
            for (let i = 0; i < pulseCount; i++) {
              const delayMs = i * pulseIntervalMinutes * 60 * 1000;
              const windowClosesAt = Date.now() + delayMs + durationMinutes * 60 * 1000;

              if (i === 0) {
                // First pulse opens immediately
                const window = await checkinStore.createWindow({
                  tutorId: agentId,
                  mode: "pulse",
                  topic,
                  pulseGroupId,
                  pulseIndex: 1,
                  pulseTotal: pulseCount,
                  closesAt: windowClosesAt,
                });
                windows.push(window);
              } else {
                // Schedule future pulses via cron
                const openAtMs = Date.now() + delayMs;
                const channelId = context?.channelId || "";
                await cronService.add({
                  name: `Pulse ${i + 1}/${pulseCount}`,
                  message: `[SYSTEM:PULSE_CHECKIN] pulseGroupId=${pulseGroupId} pulseIndex=${i + 1} pulseTotal=${pulseCount} topic=${topic || ""} durationMinutes=${durationMinutes}`,
                  channelId,
                  agentId,
                  schedule: { kind: "at", atMs: openAtMs },
                  enabled: true,
                });
              }
            }

            // Schedule auto-close for first window
            const channelId = context?.channelId || "";
            if (channelId) {
              await cronService.add({
                name: `Auto-close pulse 1/${pulseCount}`,
                message: `[SYSTEM:CLOSE_CHECKIN] windowId=${windows[0].id}`,
                channelId,
                agentId,
                schedule: { kind: "at", atMs: closesAt },
                enabled: true,
              });
            }

            return [
              `Pulse check-in session started:`,
              `- Group ID: ${pulseGroupId}`,
              `- Pulses: ${pulseCount} (every ${pulseIntervalMinutes} min, ${durationMinutes} min each)`,
              `- Topic: ${topic || "(none)"}`,
              `- First window ID: ${windows[0].id} (open now, closes ${new Date(closesAt).toISOString()})`,
              ``,
              `Use relay to notify students that pulse check-ins are active.`,
            ].join("\n");
          }

          // Non-pulse modes: single window
          const window = await checkinStore.createWindow({
            tutorId: agentId,
            mode,
            topic: input.topic as string,
            passphrase: mode === "passphrase" ? (input.passphrase as string) : undefined,
            challenges: mode === "quiz" ? (input.challenges as { userId: string; question: string }[]) : undefined,
            closesAt,
          });

          // Schedule auto-close
          const channelId = context?.channelId || "";
          if (channelId) {
            await cronService.add({
              name: `Auto-close check-in`,
              message: `[SYSTEM:CLOSE_CHECKIN] windowId=${window.id}`,
              channelId,
              agentId,
              schedule: { kind: "at", atMs: closesAt },
              enabled: true,
            });
          }

          const modeInfo = mode === "passphrase"
            ? `Passphrase: "${window.passphrase}" (do NOT relay this to students)`
            : mode === "quiz"
              ? `Challenges: ${window.challenges?.length ?? 0} per-student questions`
              : `Topic: ${window.topic || "(none)"}`;

          return [
            `Check-in window opened:`,
            `- ID: ${window.id}`,
            `- Mode: ${mode}`,
            `- ${modeInfo}`,
            `- Duration: ${durationMinutes} minutes`,
            `- Closes: ${new Date(closesAt).toISOString()}`,
            ``,
            `Use relay to distribute the check-in to students.`,
            mode === "passphrase" ? `IMPORTANT: Only tell students to "enter the passphrase shown in class". Do NOT include the passphrase in the relay message.` : "",
          ].filter(Boolean).join("\n");
        }

        case "close": {
          // Close expired windows first
          await checkinStore.closeExpiredWindows();

          const windowId = input.windowId as string;
          if (windowId) {
            const window = await checkinStore.closeWindow(windowId);
            if (!window) return `No window found with ID ${windowId}.`;
            return `Check-in window "${window.id}" (${window.mode}) closed.`;
          }

          // Close active window
          const active = await checkinStore.getActiveWindow();
          if (!active) return "No active check-in window to close.";
          const window = await checkinStore.closeWindow(active.id);
          return `Check-in window "${window!.id}" (${window!.mode}) closed.`;
        }

        case "evaluate": {
          await checkinStore.closeExpiredWindows();
          type CheckinStatus = "checked_in" | "late" | "absent" | "needs_review";

          const evaluations = input.evaluations as { responseId: string; score: number; status: string; feedback?: string }[];

          if (evaluations && evaluations.length > 0) {
            // Direct evaluation with provided scores
            const updated = await checkinStore.bulkEvaluate(
              evaluations.map((e) => ({
                responseId: e.responseId,
                score: e.score,
                status: e.status as CheckinStatus,
                feedback: e.feedback,
              })),
            );

            // Auto-notify students of their scores via DM
            const notify = input.notifyStudents as boolean;
            let notified = 0;
            if (notify) {
              notified = await notifyStudentsOfScores(agentId, checkinStore, evaluations);
            }

            const notifyMsg = notify ? ` ${notified} student(s) notified.` : "";
            return `Evaluated ${updated} response(s).${notifyMsg}`;
          }

          // No evaluations provided — return responses for AI assessment
          const windowId = input.windowId as string;
          let targetWindow;
          if (windowId) {
            targetWindow = await checkinStore.getWindow(windowId);
          } else {
            // Find most recent closed window
            const all = await checkinStore.listWindows();
            targetWindow = all.filter((w) => w.status === "closed").sort((a, b) => b.openedAt - a.openedAt)[0];
          }

          if (!targetWindow) return "No closed check-in window found to evaluate.";

          const responses = await checkinStore.getResponsesByWindow(targetWindow.id);
          const students = getStudentsForTutor(agentId);
          const allUserIds = students.flatMap((s) => s.allowedUsers);

          if (targetWindow.mode === "passphrase" && targetWindow.passphrase) {
            // Auto-evaluate passphrase mode
            const evals = responses.map((r) => ({
              responseId: r.id,
              score: r.content.trim().toLowerCase() === targetWindow!.passphrase!.trim().toLowerCase() ? 100 : 0,
              status: (r.content.trim().toLowerCase() === targetWindow!.passphrase!.trim().toLowerCase() ? "checked_in" : "needs_review") as CheckinStatus,
              feedback: r.content.trim().toLowerCase() === targetWindow!.passphrase!.trim().toLowerCase() ? "Correct passphrase." : `Incorrect. Expected "${targetWindow!.passphrase}".`,
            }));
            const updated = await checkinStore.bulkEvaluate(evals);

            // Mark absent students
            const respondedUserIds = new Set(responses.map((r) => r.userId));
            const absentCount = allUserIds.filter((u) => !respondedUserIds.has(u)).length;

            // Auto-notify if requested
            const notify = input.notifyStudents as boolean;
            let notified = 0;
            if (notify) {
              notified = await notifyStudentsOfScores(agentId, checkinStore, evals.map((e, i) => ({
                responseId: e.responseId,
                score: e.score,
                status: e.status,
                feedback: e.feedback,
              })));
            }

            const notifyMsg = notify ? ` ${notified} student(s) notified.` : "";
            return `Passphrase auto-evaluated: ${updated} response(s) scored. ${evals.filter((e) => e.score === 100).length} correct, ${evals.filter((e) => e.score === 0).length} incorrect. ${absentCount} absent (no response).${notifyMsg}`;
          }

          // For quiz/reflect/pulse: return responses for AI to evaluate
          if (responses.length === 0) return `No responses for window ${targetWindow.id}. All students absent.`;

          const lines = responses.map((r) => {
            const challenge = targetWindow!.challenges?.find((c) => c.userId === r.userId);
            return [
              `- Response ID: ${r.id}`,
              `  Student: <@${r.userId}>`,
              challenge ? `  Question: ${challenge.question}` : "",
              `  Answer: ${r.content}`,
              `  Submitted: ${new Date(r.submittedAt).toISOString()}`,
              r.score != null ? `  Already scored: ${r.score}` : "",
            ].filter(Boolean).join("\n");
          });

          const respondedUserIds = new Set(responses.map((r) => r.userId));
          const absent = allUserIds.filter((u) => !respondedUserIds.has(u));

          return [
            `Window: ${targetWindow.id} (${targetWindow.mode})`,
            targetWindow.topic ? `Topic: ${targetWindow.topic}` : "",
            ``,
            `Responses (${responses.length}):`,
            lines.join("\n\n"),
            absent.length > 0 ? `\nAbsent (${absent.length}): ${absent.map((u) => `<@${u}>`).join(", ")}` : "",
            ``,
            `Score each response 0-100 and call evaluate again with the evaluations array.`,
          ].filter(Boolean).join("\n");
        }

        case "report": {
          await checkinStore.closeExpiredWindows();

          const pulseGroupId = input.pulseGroupId as string;
          const windowId = input.windowId as string;

          const students = getStudentsForTutor(agentId);
          const allUserIds = students.flatMap((s) => s.allowedUsers);

          if (pulseGroupId) {
            // Aggregate report across pulse group
            const windows = await checkinStore.listWindows({ pulseGroupId });
            if (windows.length === 0) return `No windows found for pulse group ${pulseGroupId}.`;

            const userStats = new Map<string, { responded: number; totalScore: number; evaluated: number }>();
            for (const uid of allUserIds) {
              userStats.set(uid, { responded: 0, totalScore: 0, evaluated: 0 });
            }

            for (const w of windows) {
              const responses = await checkinStore.getResponsesByWindow(w.id);
              for (const r of responses) {
                const stats = userStats.get(r.userId) || { responded: 0, totalScore: 0, evaluated: 0 };
                stats.responded++;
                if (r.score != null) {
                  stats.totalScore += r.score;
                  stats.evaluated++;
                }
                userStats.set(r.userId, stats);
              }
            }

            const total = windows.length;
            const lines = [...userStats.entries()].map(([uid, stats]) => {
              const pct = Math.round((stats.responded / total) * 100);
              const avgScore = stats.evaluated > 0 ? Math.round(stats.totalScore / stats.evaluated) : "N/A";
              return `  <@${uid}>: ${stats.responded}/${total} (${pct}%) — avg score: ${avgScore}`;
            });

            return [
              `Pulse Check-in Report (group: ${pulseGroupId})`,
              `Windows: ${total} (${windows.filter((w) => w.status === "closed").length} closed, ${windows.filter((w) => w.status === "open").length} open)`,
              ``,
              `Per-student attendance:`,
              ...lines,
            ].join("\n");
          }

          // Single window report
          let targetWindow;
          if (windowId) {
            targetWindow = await checkinStore.getWindow(windowId);
          } else {
            const all = await checkinStore.listWindows();
            targetWindow = all.sort((a, b) => b.openedAt - a.openedAt)[0];
          }

          if (!targetWindow) return "No check-in windows found.";

          const responses = await checkinStore.getResponsesByWindow(targetWindow.id);
          const respondedUserIds = new Set(responses.map((r) => r.userId));
          const absent = allUserIds.filter((u) => !respondedUserIds.has(u));
          const evaluated = responses.filter((r) => r.score != null);
          const avgScore = evaluated.length > 0
            ? Math.round(evaluated.reduce((sum, r) => sum + r.score!, 0) / evaluated.length)
            : "N/A";

          const statusCounts = {
            checked_in: responses.filter((r) => r.status === "checked_in").length,
            needs_review: responses.filter((r) => r.status === "needs_review").length,
            late: responses.filter((r) => r.status === "late").length,
          };

          const studentLines = responses.map((r) => {
            const scoreStr = r.score != null ? `score: ${r.score}` : "not evaluated";
            return `  <@${r.userId}>: ${r.status ?? "pending"} (${scoreStr})${r.feedback ? ` — ${r.feedback}` : ""}`;
          });

          return [
            `Check-in Report: ${targetWindow.mode} (${targetWindow.id})`,
            `Status: ${targetWindow.status}`,
            targetWindow.topic ? `Topic: ${targetWindow.topic}` : "",
            `Opened: ${new Date(targetWindow.openedAt).toISOString()}`,
            `Closed: ${new Date(targetWindow.closesAt).toISOString()}`,
            ``,
            `Summary: ${responses.length} responded, ${absent.length} absent`,
            `Average score: ${avgScore}`,
            statusCounts.checked_in > 0 ? `Checked in: ${statusCounts.checked_in}` : "",
            statusCounts.needs_review > 0 ? `Needs review: ${statusCounts.needs_review}` : "",
            statusCounts.late > 0 ? `Late: ${statusCounts.late}` : "",
            ``,
            `Students:`,
            ...studentLines,
            absent.length > 0 ? `\nAbsent: ${absent.map((u) => `<@${u}>`).join(", ")}` : "",
          ].filter(Boolean).join("\n");
        }

        default:
          return `Unknown action: ${action}. Use open, close, evaluate, or report.`;
      }
    },
  };
}

/**
 * DM each evaluated student their score and feedback.
 * Posts directly via the student agent's bot token — no AI loop overhead.
 */
async function notifyStudentsOfScores(
  tutorId: string,
  checkinStore: CheckinStore,
  evaluations: { responseId: string; score: number; status: string; feedback?: string }[],
): Promise<number> {
  const students = getStudentsForTutor(tutorId);
  const userToAgent = new Map<string, string>();
  for (const s of students) {
    for (const uid of s.allowedUsers) userToAgent.set(uid, s.id);
  }

  let notified = 0;
  const tasks = evaluations.map(async (ev) => {
    const response = await checkinStore.getResponse(ev.responseId);
    const userId = response?.userId;
    if (!userId) return;
    const studentAgentId = userToAgent.get(userId);
    if (!studentAgentId) return;
    const agent = getRegisteredAgent(studentAgentId);
    if (!agent) return;

    try {
      const dm = await agent.slackClient.conversations.open({ users: userId });
      const channelId = dm.channel?.id;
      if (!channelId) return;

      const scoreEmoji = ev.score >= 80 ? "\u2705" : ev.score >= 50 ? "\u26a0\ufe0f" : "\u274c";
      const msg = [
        `${scoreEmoji} *Check-in result: ${ev.score}/100*`,
        ev.feedback ? `> ${ev.feedback}` : "",
      ].filter(Boolean).join("\n");

      await agent.slackClient.chat.postMessage({ channel: channelId, text: markdownToSlack(msg) });
      notified++;
    } catch (err) {
      console.warn(`[checkin] Failed to notify student:`, err instanceof Error ? err.message : err);
    }
  });

  await Promise.allSettled(tasks);
  return notified;
}
