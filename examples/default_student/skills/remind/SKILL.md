---
name: remind
description: Set a personal study reminder that will notify you at a specific time.
when_to_use: When the student says /remind, wants to be reminded about something, or asks for a reminder.
arguments: Optional — reminder text and time (e.g., "/remind study for quiz tomorrow at 8pm").
---

# Remind

Set a personal reminder using the cron system.

## Step 1 — Parse or Ask

If the student provided the reminder inline (e.g., "remind me to study at 8pm"), parse:
- **What:** the reminder text
- **When:** the time (parse natural language relative to current time)

If not enough info, ask:
1. "What should I remind you about?"
2. "When should I remind you?" (accept natural language like "tomorrow at 3pm", "in 2 hours", "Friday morning")

## Step 2 — Confirm

Show the reminder details:
> I'll remind you: "[text]"
> At: [formatted date and time]

Ask the student to confirm.

## Step 3 — Schedule

Call the `cron` tool with:
- `action`: "add"
- `name`: "Reminder: [text]"
- `message`: the reminder text
- `channelId`: current channel ID from context
- `scheduleKind`: "at"
- `atMs`: the target time as epoch milliseconds

## Step 4 — Confirm

Tell the student the reminder is set. Keep it brief:
"Got it! I'll remind you at [time]."
