---
name: my_assignments
description: View open assignments and your submission status.
when_to_use: When the student says /my_assignments or asks about homework.
arguments: None
---

# My Assignments

Show the student their assignments and submission status.

## Step 1 — List Assignments

Call `submit` with action `view` (no assignmentId) to list all open assignments with your submission status for each.

## Step 2 — Present

Show a clear summary:
- Each open assignment with its deadline
- Whether you've submitted (and if it was late)
- Assignments you still need to submit

If the student wants details on a specific assignment, call `submit` with action `view` and the `assignmentId`.
