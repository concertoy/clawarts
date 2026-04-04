# clawarts

Multi-agent Slack bot for course management. Each agent runs its own AI loop and communicates via Slack Socket Mode.

## Architecture

```
Tutor Agent ──relay──> Student Agent(s)
     │                      │
     ├─ assignments         ├─ submissions
     ├─ announcements       ├─ my_assignments
     ├─ cron reminders      └─ guided learning
     └─ full tool access        (read-only tools)
```

- **Tutor agents** have full tool access, manage assignments, and broadcast to students via relay
- **Student agents** have restricted tools, submit work, and guide learners through problems
- Agents share assignment data through a JSON file store — no database required

## Setup

```bash
npm install
```

Create a `.env` file:

```
TUTOR_SLACK_BOT_TOKEN=xoxb-...
TUTOR_SLACK_APP_TOKEN=xapp-...
STUDENT_SLACK_BOT_TOKEN=xoxb-...
STUDENT_SLACK_APP_TOKEN=xapp-...
ANTHROPIC_API_KEY=sk-ant-...   # if using anthropic-claude provider
```

Run the interactive setup wizard or edit `config.json` directly:

```bash
npm run cli setup        # interactive wizard
npm run cli agent add    # add a single agent
npm run cli agent list   # list configured agents
```

## Run

```bash
npm run dev   # development (auto-reload)
npm start     # production
```

## Config

`config.json` defines agents with defaults and per-agent overrides:

```json
{
  "defaults": { "provider": "openai-codex", "model": "gpt-5.4" },
  "agents": [
    { "id": "tutor", "slackBotToken": "$TUTOR_SLACK_BOT_TOKEN", "slackAppToken": "$TUTOR_SLACK_APP_TOKEN" },
    { "id": "student-1", "linkedTutor": "tutor", "disallowedTools": ["bash", "write_file", "edit", "multi_edit"] }
  ]
}
```

Providers: `anthropic-claude` (Claude), `openai-codex` (GPT).

## Tools

| Tool | Category | Access |
|------|----------|--------|
| `read_file`, `write_file`, `edit`, `multi_edit` | filesystem | tutor |
| `bash` | shell | tutor |
| `grep`, `glob`, `ls` | search | all |
| `web_search`, `web_fetch` | web | all |
| `cron` | scheduling | all |
| `relay`, `list_students` | communication | tutor |
| `assignment` | academic | tutor |
| `submit` | academic | student |

## Skills

Skills are prompt-driven workflows defined in `SKILL.md` files:

- `/new_homework` — create and announce assignments to students
- `/announcement` — broadcast free-format messages
- `/check_submissions` — review submission status
- `/my_assignments` — student view of open assignments
- `/slack_format` — Slack mrkdwn formatting guide

Skills live in `examples/default_tutor/skills/` and `examples/default_student/skills/`, and are copied to agent workspaces on first startup.

## Data

Agent state is stored in `~/.clawarts/agents/{id}/`:

```
~/.clawarts/agents/tutor/
  workspace/          # SOUL.md, IDENTITY.md, skills/
  data/               # assignments.json, submissions.json
  cron/               # jobs.json
```

## License

MIT
