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

export interface CourseHomework {
  title: string;
  description: string;
  deadline: string; // ISO date string
  weekDate: string; // week start date
}

export interface CourseCheckin {
  mode: "passphrase" | "quiz" | "pulse" | "reflect";
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
}

const VALID_CHECKIN_MODES = new Set<CourseCheckin["mode"]>(["passphrase", "quiz", "pulse", "reflect"]);

export function parseCourseSchedule(markdown: string): CourseSchedule {
  const lines = markdown.split("\n");

  // Extract course title from first heading
  let title = "Untitled Course";
  const titleMatch = lines[0]?.match(/^#\s+(.+)/);
  if (titleMatch) title = titleMatch[1].trim();

  const homeworks: CourseHomework[] = [];
  const checkins: CourseCheckin[] = [];
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
      const mode: CourseCheckin["mode"] = VALID_CHECKIN_MODES.has(rawMode as CourseCheckin["mode"]) ? (rawMode as CourseCheckin["mode"]) : "reflect";
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

  return { title, homeworks, checkins };
}
