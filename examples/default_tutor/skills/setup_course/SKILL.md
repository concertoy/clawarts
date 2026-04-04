---
name: setup_course
description: Read COURSE.md from the workspace and auto-create all assignments and schedule all check-ins for the semester.
when_to_use: When the tutor says /setup_course or wants to set up the whole course schedule at once.
arguments: None — reads COURSE.md from the workspace automatically.
---

# Setup Course

Batch-create assignments and schedule check-ins from a COURSE.md file.

## Step 1 — Read COURSE.md

Read `COURSE.md` from the workspace using `read_file`. If it doesn't exist, tell the tutor to create one with this format:

```markdown
# CS101 — Intro to Programming

## Week 1 (2026-09-07)
- homework: "Variables & Types" due 2026-09-14
  > Write a program that demonstrates 5 different data types.
- checkin: quiz topic="variables and types" duration=5

## Week 2 (2026-09-14)
- homework: "Control Flow" due 2026-09-21
  > Implement FizzBuzz and explain your approach.
- checkin: reflect topic="loops and conditionals"
```

## Step 2 — Parse and Preview

Parse the COURSE.md content. Show the tutor a summary:
- Course title
- Number of homework assignments with titles and deadlines
- Number of check-in sessions with modes and topics

Ask the tutor to confirm before creating anything.

## Step 3 — Create Assignments

For each homework entry, call the `assignment` tool with action `create`:
- `title`: the homework title
- `description`: the indented description text (lines starting with >)
- `deadline`: the due date as ISO 8601 (add T23:59:00Z to the date)
- `format`: "individual" (default)

## Step 4 — Schedule Check-ins

For each check-in entry, call the `cron` tool to schedule it:
- `name`: "Check-in: [topic]"
- `message`: A message that will remind you to run `/launch_checkin` with the specified mode and topic
- `scheduleKind`: "at"
- `atMs`: Convert the week date to epoch ms (add class time, e.g. 10:00 AM)

Note: Since check-ins are interactive (they need relay to students), the cron job reminds the tutor to launch them rather than auto-launching.

## Step 5 — Report

Show the tutor:
- How many assignments were created
- How many check-in reminders were scheduled
- Any entries that failed (with reasons)
