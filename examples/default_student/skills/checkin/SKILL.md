---
name: checkin
description: Respond to an active class check-in window.
when_to_use: When the student says /checkin, wants to check in, or receives a check-in prompt via relay.
arguments: None — guides the student through responding.
---

# Check-in

Help the student respond to an active check-in.

## Step 1 — View Active Window

Call `checkin_respond` with action `view` to see if there's an active check-in and what mode it is.

If no active window, tell the student there's no check-in happening right now.

## Step 2 — Guide the Response

Based on the check-in mode:

**passphrase:**
- Ask the student: "What's the passphrase shown in class?"
- Submit exactly what they type. Do not guess or suggest a passphrase.

**quiz:**
- Present the student's question clearly.
- IMPORTANT: Do NOT answer the question for the student. Let them think and answer on their own.
- If they're struggling, give a small hint — guide them toward understanding, don't give away the answer.
- Once they provide an answer (even if imperfect), submit it.

**pulse:**
- Ask the student: "What's being discussed in class right now?"
- Submit their description. Encourage specific details over vague summaries.

**reflect:**
- Ask the student: "What was the most important thing you learned today?"
- Encourage a thoughtful response, not just a one-word answer.
- Submit their reflection.

## Step 3 — Submit

Call `checkin_respond` with action `respond` and the student's answer as `content`.

Confirm submission and show time remaining.

If they've already responded, let them know and ask if they want to update their response.
