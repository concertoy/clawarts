---
name: check_submissions
description: Review assignment submissions and identify students who haven't submitted.
when_to_use: When the tutor says /check_submissions or wants to see who submitted.
arguments: Optional assignment title or ID.
---

# Check Submissions

Review submission status for an assignment.

## Step 1 — Select Assignment

Call `assignment` with action `list` to show all assignments. If the tutor specified an assignment, use it directly. Otherwise, ask which assignment to check.

## Step 2 — Show Details

Call `assignment` with action `get` and the selected `assignmentId`. This returns:
- All submissions (who submitted, when, late or on time)
- Who hasn't submitted yet

## Step 3 — Report

Present a summary:
- Total submitted vs total students
- Late submissions
- Missing students (not yet submitted)

If the tutor wants to send a reminder to missing students, use `relay` to message each one through their student agent.
