/**
 * Course schedule parser.
 * Reads COURSE.md from a tutor's workspace and extracts homework + check-in entries.
 * The tutor agent calls this via the /setup_course skill to batch-create
 * assignments and schedule check-ins.
 *
 * Format:
 *   ## Week N (YYYY-MM-DD)
 *   - homework: "Title" due YYYY-MM-DD
 *     > Description text (optional, multi-line with > prefix)
 *   - checkin: MODE topic="..." [duration=N] [count=N] [interval=N]
 */

import type { CheckinMode } from "./store/types.js";

export interface CourseHomework {
  title: string;
  description: string;
  deadline: string; // ISO date string
  weekDate: string; // week start date
}

export interface CourseCheckin {
  mode: CheckinMode;
  topic?: string;
  durationMinutes?: number;
  pulseCount?: number;
  pulseIntervalMinutes?: number;
  weekDate: string; // when to schedule
}

export interface CourseSchedule {
  title: string;
  homeworks: CourseHomework[];
  checkins: CourseCheckin[];
  warnings: string[];
}

const VALID_CHECKIN_MODES = new Set<CheckinMode>(["passphrase", "quiz", "pulse", "reflect"]);

export function parseCourseSchedule(markdown: string): CourseSchedule {
  const lines = markdown.split("\n");

  // Extract course title from first heading
  let title = "Untitled Course";
  const titleMatch = lines[0]?.match(/^#\s+(.+)/);
  if (titleMatch) title = titleMatch[1].trim();

  const homeworks: CourseHomework[] = [];
  const checkins: CourseCheckin[] = [];
  const warnings: string[] = [];
  let currentWeekDate = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match ## Week N (YYYY-MM-DD)
    const weekMatch = line.match(/^##\s+.*?\((\d{4}-\d{2}-\d{2})\)/);
    if (weekMatch) {
      currentWeekDate = weekMatch[1];
      continue;
    }

    // Match - homework: "Title" due YYYY-MM-DD
    const hwMatch = line.match(/^-\s+homework:\s+"([^"]+)"\s+due\s+(\d{4}-\d{2}-\d{2})/);
    if (hwMatch) {
      const hwTitle = hwMatch[1];
      const deadline = hwMatch[2];

      // Collect description lines (> prefixed)
      const descLines: string[] = [];
      while (i + 1 < lines.length && lines[i + 1].match(/^\s*>\s*/)) {
        i++;
        descLines.push(lines[i].replace(/^\s*>\s*/, ""));
      }

      if (!currentWeekDate) warnings.push(`Homework "${hwTitle}" has no week context (add a ## Week heading above it)`);
      // Validate date format strictly (YYYY-MM-DD) before parsing
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
        warnings.push(`Homework "${hwTitle}" has malformed deadline "${deadline}" (expected YYYY-MM-DD)`);
      }
      const deadlineMs = new Date(deadline + "T23:59:00Z").getTime();
      if (!Number.isFinite(deadlineMs)) warnings.push(`Homework "${hwTitle}" has invalid deadline: ${deadline}`);

      homeworks.push({
        title: hwTitle,
        description: descLines.join("\n").trim(),
        deadline,
        weekDate: currentWeekDate,
      });
      continue;
    }

    // Match - checkin: MODE key="value" key=N ...
    const ciMatch = line.match(/^-\s+checkin:\s+(\w+)\s*(.*)/);
    if (ciMatch) {
      const rawMode = ciMatch[1];
      if (!VALID_CHECKIN_MODES.has(rawMode as CheckinMode)) {
        warnings.push(`Line ${i + 1}: unknown check-in mode "${rawMode}", defaulting to "reflect"`);
      }
      const mode: CheckinMode = VALID_CHECKIN_MODES.has(rawMode as CheckinMode) ? (rawMode as CheckinMode) : "reflect";
      const rest = ciMatch[2] || "";

      const topicMatch = rest.match(/topic="([^"]+)"/);
      const durationMatch = rest.match(/duration=(\d+)/);
      const countMatch = rest.match(/count=(\d+)/);
      const intervalMatch = rest.match(/interval=(\d+)/);

      checkins.push({
        mode,
        topic: topicMatch?.[1],
        durationMinutes: durationMatch ? parseInt(durationMatch[1], 10) : undefined,
        pulseCount: countMatch ? parseInt(countMatch[1], 10) : undefined,
        pulseIntervalMinutes: intervalMatch ? parseInt(intervalMatch[1], 10) : undefined,
        weekDate: currentWeekDate,
      });
      continue;
    }
  }

  if (homeworks.length === 0 && checkins.length === 0) {
    warnings.push("No homework or check-in entries found. Check the COURSE.md format.");
  }

  return { title, homeworks, checkins, warnings };
}
