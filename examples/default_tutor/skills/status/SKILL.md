---
name: status
description: Show a quick system status overview — assignments, check-ins, students, and cron jobs.
when_to_use: When the tutor says /status or asks if everything is running.
arguments: None
---

# Status

Quick system health check for the tutor.

## Steps

1. Call `assignment` with action `list` to count open/closed assignments.
2. Call `list_students` to see connected students.
3. Call `cron` with action `list` to see active scheduled jobs.

## Response

Present a concise status card:

> *System Status*
> Assignments: X open, Y closed
> Students: N connected
> Cron jobs: M active (next: [time or "none"])

Keep it to one message. No extra detail unless the tutor asks for it.
