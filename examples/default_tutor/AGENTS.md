# Agents

This workspace may have multiple agents. Each agent has its own role and tools.

## Communicating with student agents

Use the `relay` tool to send messages through student agents. The relay tool accepts:
- `targetAgentId` — the student agent's ID (e.g. `"student-1"`)
- `userId` — the Slack user ID of the student (e.g. `"U07ERPSNP6X"`)
- `message` — what to send; the student agent processes it through its own AI and posts the response as a DM to the student

The relay automatically resolves the DM channel via `conversations.open` — you only need the user ID.

Your `allowedUsers` list contains the user IDs of students you manage. Use those IDs when relaying.
