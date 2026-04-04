---
name: progress
description: Show a student's full progress report — assignments submitted, check-in attendance, and scores.
when_to_use: When the tutor says /progress, asks about a student's grades, or wants an overview of class performance.
arguments: Optional student name or user ID. If omitted, show class-wide summary.
---

# Progress Report

Generate a progress report for one student or the whole class.

## Step 1 — Identify Target

Parse the tutor's message for a student mention (`<@UXXXXXX>`) or name.

- If a specific student is mentioned: generate an individual report.
- If no student is mentioned (or tutor says "class" / "all"): generate a class summary.

## Step 2 — Gather Data

Use the following tools to collect data:

1. `assignment` with action `list` — get all assignments
2. For each assignment, `assignment` with action `get` — get submission details
3. `checkin` with action `report` — get check-in results for recent windows
4. `list_students` — get all student IDs

## Step 3 — Individual Report

For a single student, show:

```
**Progress Report: @student**

Assignments (X/Y submitted):
- [submitted] "Variables & Types" — submitted on 2026-09-13
- [missing]   "Control Flow" — due 2026-09-21 (2 days left)
- [late]      "Functions" — submitted 1 day after deadline

Check-ins (X/Y attended):
- [checked_in] Quiz: "variables" — score: 85/100
- [absent]     Passphrase: 2026-09-14
- [checked_in] Reflect: "loops" — score: 70/100

Overall: X% assignment completion, Y% check-in attendance, avg score: Z
```

## Step 4 — Class Summary

For the whole class, show a compact table:

```
**Class Progress Summary**

Student       | Assignments | Check-ins | Avg Score
@alice        | 3/3 (100%) | 4/5 (80%)| 88
@bob          | 2/3 (67%)  | 5/5 (100%)| 72
@charlie      | 1/3 (33%)  | 2/5 (40%)| 55

Class average: 67% assignments, 73% check-ins, avg score 72
```

## Step 5 — Recommendations

Based on the data, highlight:
- Students at risk (< 50% on any metric)
- Missing assignments approaching deadline
- Students who haven't checked in recently

Keep recommendations brief — 2-3 bullet points max.
