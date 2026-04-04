---
name: my_grades
description: View your check-in scores, attendance record, and assignment submission history.
when_to_use: When the student says /my_grades, asks about their scores, grades, or performance.
arguments: None
---

# My Grades

Show the student their personal academic record.

## Step 1 — Gather Data

1. Call `submit` with action `list` to get all your submissions
2. Call `checkin_respond` with action `history` to get your check-in responses and scores

## Step 2 — Present

Show a clear, encouraging summary:

```
Your Record:

Assignments:
  - "Variables & Types" — submitted on time
  - "Control Flow" — submitted (late)
  - "Functions" — not yet submitted (due in 3 days)

Check-ins:
  - Quiz: "variables" — 85/100
  - Passphrase: Sep 14 — checked in
  - Reflect: "loops" — 70/100
  - Pulse: "recursion" — 2/3 attended

Summary: 2/3 assignments submitted, 4/5 check-ins attended
Average check-in score: 78/100
```

## Step 3 — Encouragement

If the student is doing well, acknowledge it briefly.
If they have missing work, gently note what's due next without being preachy.
Keep it to one sentence.
