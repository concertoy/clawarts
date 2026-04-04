---
name: launch_checkin
description: Open a class check-in window and distribute to students. Supports passphrase, quiz, pulse, and reflect modes.
when_to_use: When the tutor says /launch_checkin, wants to take attendance, or start a check-in.
arguments: None — the skill collects mode and parameters interactively.
---

# Launch Check-in

Open a check-in window and notify all students.

## Step 1 — Choose Mode

Ask the tutor which check-in mode to use:

1. **passphrase** — Simple code shown on projector. Students type it in.
2. **quiz** — You generate a unique question per student on a topic. Students answer their own question.
3. **pulse** — Rolling micro-checks at intervals throughout class. Students describe what's being discussed.
4. **reflect** — Exit ticket at end of class. Students describe what they learned.

## Step 2 — Gather Parameters

Based on the chosen mode:

**passphrase:**
- Ask for the passphrase code (or generate a random one)
- Ask for duration (default: 5 minutes)

**quiz:**
- Ask for the topic (e.g. "recursion", "sorting algorithms")
- Ask for duration (default: 5 minutes)
- Use `list_students` to get all student user IDs
- Generate a unique question for each student on the topic. Vary the questions — different angles, examples, or sub-topics. Keep questions brief (1-2 sentences).

**pulse:**
- Ask for the topic
- Ask for class duration and number of pulses (default: 3 pulses over 45 minutes)
- Duration per pulse window (default: 2 minutes)

**reflect:**
- Ask for the topic (what today's class covered)
- Ask for duration (default: 10 minutes)

## Step 3 — Open Window

Call the `checkin` tool with action `open` and the gathered parameters.

For quiz mode, include the `challenges` array with per-student questions.

## Step 4 — Distribute to Students

**passphrase / pulse / reflect:** Use `relay` with `action=broadcast` to notify all students at once. Messages:
- passphrase: "A check-in is open! Enter the passphrase shown in class using `/checkin`." — Do NOT include the actual passphrase.
- pulse: "Pulse check-ins are active for this class. You'll be prompted periodically to describe what's being discussed. Stay engaged!"
- reflect: "An exit ticket is open. Describe the most important thing you learned today using `/checkin`."

**quiz:** Since each student gets a unique question, use `list_students` then call `relay` with `action=send` for each student individually, including their specific question: "Check-in time! Answer this question: [their specific question]. Use `/checkin` to respond."

## Step 5 — Confirm

Tell the tutor:
- Window ID and mode
- Duration and close time
- Number of students notified
- "Use `/check_results` or `checkin report` when the window closes to see results."

## After the Window Closes

When the tutor asks for results (or says `/check_results`):
1. Call `checkin evaluate` — for passphrase mode this auto-scores; for other modes, review each response and score 0-100 based on quality/correctness
2. Call `checkin report` to show the full breakdown
