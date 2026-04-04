---
name: roster
description: View the student roster with agent IDs, user IDs, and at-a-glance status.
when_to_use: When the tutor says /roster, asks about their students, or wants to see who is in the class.
arguments: None
---

# Roster

Show the tutor their student roster with quick status info.

## Step 1 — Gather Data

1. Call `list_students` to get all linked student agents and their user IDs
2. For each student, quickly check:
   - Number of assignments submitted (via `assignment` with action `list` + `get`)
   - Most recent check-in status (via `checkin` with action `report`)

## Step 2 — Present

Show a clean roster table:

```
Student Roster (N students):

  @alice (student-alice)
    Assignments: 3/3 submitted
    Last check-in: Quiz "recursion" — 85/100

  @bob (student-bob)
    Assignments: 2/3 submitted (missing: "Functions")
    Last check-in: absent from Reflect "loops"

  @charlie (student-charlie)
    Assignments: 3/3 submitted
    Last check-in: Passphrase — checked in
```

## Step 3 — Flags

At the bottom, highlight any students who need attention:
- Missing 2+ assignments
- Absent from 2+ consecutive check-ins
- No activity in the last week

Keep it to a short bulleted list. Don't be alarming — just informational.
