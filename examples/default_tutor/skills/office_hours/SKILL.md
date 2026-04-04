---
name: office_hours
description: Set and manage office hours schedule. Students can check when the tutor is available.
when_to_use: When the tutor says /office_hours, wants to set availability, or a student asks when office hours are.
arguments: None — collects schedule interactively.
---

# Office Hours

Manage weekly office hours and broadcast the schedule to students.

## Step 1 — Check Current Schedule

Read the file `office_hours.json` from the workspace using `read_file`.

If it exists, show the current schedule and ask if the tutor wants to update it.
If it doesn't exist, proceed to create one.

## Step 2 — Collect Schedule

Ask the tutor for their weekly office hours. Accept natural language:
- "Monday and Wednesday 2-4pm"
- "Tuesday 10am-12pm, Thursday 3-5pm"
- "Every day 1-2pm"

Parse into a structured format:

```json
{
  "timezone": "America/New_York",
  "slots": [
    { "day": "Monday", "start": "14:00", "end": "16:00" },
    { "day": "Wednesday", "start": "14:00", "end": "16:00" }
  ],
  "location": "Room 301 or Slack DM",
  "note": "No office hours during exam week"
}
```

## Step 3 — Save

Write the schedule to `office_hours.json` in the workspace using `write_file`.

Confirm with the tutor and show the formatted schedule.

## Step 4 — Announce (optional)

Ask if the tutor wants to broadcast the schedule to all students.

If yes, use `relay` with `action=broadcast` and a formatted message:

```
📅 Office Hours Schedule:
- Monday 2:00-4:00 PM
- Wednesday 2:00-4:00 PM
Location: Room 301 or Slack DM
```

## For Student Agents

When a student asks "when are office hours?" or similar:
1. Read `office_hours.json` from the workspace
2. Show the schedule with the next upcoming slot highlighted
3. If currently during office hours, say so
