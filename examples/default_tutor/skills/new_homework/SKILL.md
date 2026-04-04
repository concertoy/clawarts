---
name: new_homework
description: Create and announce a new homework assignment to all managed students.
when_to_use: When the tutor says /new_homework or wants to assign homework.
arguments: None — the skill collects all details interactively.
---

# New Homework

Collect homework details from the tutor, then announce to all students.

## Step 1 — Gather Details

Ask the tutor for each of the following, one at a time. Do not skip any field. If the tutor provides several at once, acknowledge and ask for the remaining ones.

1. **Description** — What is the assignment about?
2. **Deadline** — When is it due? (date and time)
3. **Attached files** — Any reference materials or starter files? (the tutor can paste links or upload files)
4. **Submission format** — Individual or group? If group, how many per group?

## Step 2 — Confirm

Summarize the homework in a clean format and ask the tutor to confirm:

> **Homework: [title]**
> [description]
>
> Deadline: [date]
> Format: [individual/group]
> Attachments: [list or "none"]

If the tutor wants changes, update and re-confirm.

## Step 3 — Announce

Once confirmed, use the `relay` tool to send the homework announcement through each student agent. For each student in your `allowedUsers` list:

1. Call `relay` with:
   - `targetAgentId`: the student's agent ID (e.g. `"student-1"`)
   - `userId`: the student's Slack user ID from `allowedUsers`
   - `message`: the formatted homework summary from Step 2, prefixed with "📚 **New Homework Assignment**"

2. The student agent will process the message and DM the student directly.

If a relay fails, report which students were not notified.
