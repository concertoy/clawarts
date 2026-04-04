---
name: announcement
description: Send a free-format announcement to all managed students.
when_to_use: When the tutor says /announcement or wants to broadcast a message to students.
arguments: None — the skill collects the message interactively.
---

# Announcement

Send a free-format message to all students.

## Step 1 — Compose

Ask the tutor to type their announcement. There are no required fields — accept any free-format text. If the tutor provides the message inline (e.g. `/announcement Class cancelled tomorrow`), use it directly and skip to Step 2.

## Step 2 — Confirm

Show a preview of the announcement and ask the tutor to confirm:

> :loudspeaker: *Announcement*
> [message]

If the tutor wants changes, let them edit and re-confirm.

## Step 3 — Send

Once confirmed:

1. Call `list_students` to discover all linked student agents and their user IDs.
2. For each student, call `relay` with:
   - `targetAgentId`: the student's agent ID
   - `userId`: the student's Slack user ID
   - `message`: the confirmed announcement, prefixed with ":loudspeaker: *Announcement from your tutor*"

Report how many students were notified. If any relay fails, report which students were missed.
