/**
 * DM each evaluated student their score and feedback.
 * Posts directly via the student agent's bot token — no AI loop overhead.
 * Extracted from checkin-tool.ts for reusability.
 */
import type { CheckinStore } from "../store/checkin-store.js";
import type { CheckinStatus } from "../store/types.js";
import { getStudentsForTutor, getRegisteredAgent } from "../relay.js";
import { errMsg } from "../utils/errors.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("checkin");
import { openDmChannel } from "../utils/slack-dm.js";
import { markdownToSlack } from "../utils/slack-markdown.js";

export interface EvaluationEntry {
  responseId: string;
  score: number;
  status: string;
  feedback?: string;
}

export async function notifyStudentsOfScores(
  tutorId: string,
  checkinStore: CheckinStore,
  evaluations: EvaluationEntry[],
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
      const channelId = await openDmChannel(agent.slackClient, userId);

      const scoreEmoji = ev.score >= 80 ? "\u2705" : ev.score >= 50 ? "\u26a0\ufe0f" : "\u274c";
      const msg = [
        `${scoreEmoji} *Check-in result: ${ev.score}/100*`,
        ev.feedback ? `> ${ev.feedback}` : "",
      ].filter(Boolean).join("\n");

      await agent.slackClient.chat.postMessage({ channel: channelId, text: markdownToSlack(msg) });
      notified++;
    } catch (err) {
      log.warn("Failed to notify student:", errMsg(err));
    }
  });

  await Promise.allSettled(tasks);
  return notified;
}

/**
 * Auto-evaluate passphrase responses: compare each response against the expected passphrase.
 * Returns evaluation entries ready for bulkEvaluate.
 */
export function autoEvaluatePassphrase(
  responses: { id: string; content: string }[],
  passphrase: string,
): { responseId: string; score: number; status: CheckinStatus; feedback: string }[] {
  const expected = passphrase.trim().toLowerCase();
  return responses.map((r) => {
    const correct = r.content.trim().toLowerCase() === expected;
    return {
      responseId: r.id,
      score: correct ? 100 : 0,
      status: (correct ? "checked_in" : "needs_review") as CheckinStatus,
      feedback: correct ? "Correct passphrase." : `Incorrect. Expected "${passphrase}".`,
    };
  });
}
