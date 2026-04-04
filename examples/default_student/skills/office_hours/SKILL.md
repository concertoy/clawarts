---
name: office_hours
description: Check the tutor's office hours schedule.
when_to_use: When the student asks about office hours, availability, or when they can get help.
arguments: None
---

# Office Hours

Show the student when their tutor is available.

## Step 1 — Read Schedule

Read `office_hours.json` from the workspace using `read_file`.

If it doesn't exist, tell the student that office hours haven't been posted yet and suggest asking the tutor.

## Step 2 — Present

Show the schedule clearly:
- List all weekly time slots
- Highlight the next upcoming slot (based on current date/time)
- If right now is during office hours, say "Office hours are happening now!"
- Include the location if specified
- Include any notes from the tutor

Keep it brief and friendly.
