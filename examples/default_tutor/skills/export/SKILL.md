---
name: export
description: Export assignment submissions, check-in results, and progress data as a formatted report file.
when_to_use: When the tutor says /export or wants to download grades, submissions, or check-in data.
arguments: Optional scope — "assignments", "checkins", "all" (default: all).
---

# Export Data

Generate a summary report file the tutor can download or copy.

## Step 1 — Determine Scope

Parse the tutor's message for what to export:
- "assignments" — submissions and deadlines only
- "checkins" — check-in attendance and scores only
- "all" — everything (default)

## Step 2 — Gather Data

Use tools to collect:
1. `assignment` with action `list` — all assignments
2. For each assignment, `assignment` with action `get` — submissions
3. `checkin` with action `report` — recent check-in windows
4. `list_students` — student roster

## Step 3 — Generate Report

Write a Markdown report to the workspace using `write_file`:

**Filename:** `exports/report-YYYY-MM-DD.md`

**Format:**
```markdown
# Course Report — Generated YYYY-MM-DD

## Student Roster
| Student | Agent ID |
|---------|----------|

## Assignments
### [Title] (deadline: YYYY-MM-DD)
| Student | Status | Submitted | Late? |
|---------|--------|-----------|-------|

## Check-ins
### [Mode]: [Topic] (YYYY-MM-DD)
| Student | Status | Score | Feedback |
|---------|--------|-------|----------|

## Summary
| Student | Assignments | Check-ins | Avg Score |
|---------|-------------|-----------|-----------|
```

## Step 4 — Deliver

Upload the report file to the current Slack conversation using `slack_upload`.

Tell the tutor where the file is saved in the workspace and that it's attached above.
