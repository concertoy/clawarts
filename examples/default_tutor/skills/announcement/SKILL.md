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

Once confirmed, call `relay` with:
- `action`: `broadcast`
- `message`: the confirmed announcement, prefixed with ":loudspeaker: *Announcement from your tutor*"

This sends to all linked students in parallel — one tool call reaches everyone. Report the delivery summary.

## Step 4 — Archive

After sending, append the announcement to `announcements.md` in the workspace using `edit` (or `write_file` if the file doesn't exist). Format:

```markdown
## [DATE] — Announcement
[message text]
Delivered to: X students
```

This creates a running log the tutor can review later.
