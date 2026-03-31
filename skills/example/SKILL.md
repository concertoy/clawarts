---
name: example
description: An example skill that demonstrates the skill system. Use this when the user asks about how skills work or wants to test skill loading.
---

# Example Skill

This is a demonstration skill for Clawarts.

## When to Use

Use this skill when a user asks about skills, how they work, or wants to verify that the skill system is functioning.

## Instructions

When this skill is activated, tell the user:
1. Skills are markdown files with YAML frontmatter stored in `skills/<name>/SKILL.md`
2. They are automatically discovered and injected into the system prompt
3. The agent reads the SKILL.md file on-demand when a skill matches
4. Skills can provide instructions, context, and workflows for specific tasks
