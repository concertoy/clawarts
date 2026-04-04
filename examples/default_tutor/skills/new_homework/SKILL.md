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

## Step 3 — Create Assignment

Once confirmed, call `assignment` with:
- `action`: `create`
- `title`: the homework title
- `description`: the full description
- `deadline`: ISO date string (e.g. "2026-09-14T23:59:00Z")
- `format`: "individual" or "group"
- `attachments`: array of URLs/filenames (or empty)

This saves the assignment to the store so students can view and submit against it.

## Step 4 — Announce

Call `relay` with:
- `action`: `broadcast`
- `message`: the formatted homework summary from Step 2, prefixed with "📚 **New Homework Assignment**". Include the assignment ID from Step 3 so students can reference it.

This sends to all linked students in parallel. Report the delivery summary.
