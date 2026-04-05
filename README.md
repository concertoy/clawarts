# clawarts

Multi-agent Slack bot for course management. Tutor and student agents run independent AI loops, communicate via relay, and connect to Slack through Socket Mode.

## Quick start

```bash
npm install
npm run cli setup     # interactive config wizard
npm run dev           # start with auto-reload
```

Or configure manually: create `config.json` and a `.env` file (see [Config](#config) below), then `npm start`.

## Architecture

```
Tutor Agent ──relay/broadcast──> Student Agent(s)
     │                                │
     ├─ assignments, check-ins        ├─ submissions, responses
     ├─ announcements, grades         ├─ my_grades, my_assignments
     ├─ cron scheduling               └─ guided learning (helpLevel)
     └─ full tool access                  (restricted tools)
```

- **Tutor agents** manage assignments, run check-ins, broadcast announcements, and have full tool access
- **Student agents** submit work, respond to check-ins, and get AI tutoring with configurable guardrails
- **Relay** enables cross-agent messaging; `broadcast` fans out to all students in parallel
- **Cron** schedules recurring jobs (reminders, check-ins) with precise `setTimeout` targeting
- All data stored as JSON files in `~/.clawarts/` -- no database required

## Config

`config.json` defines agents with shared defaults and per-agent overrides:

```json
{
  "defaults": {
    "provider": "anthropic-claude",
    "model": "claude-sonnet-4-5-20250514"
  },
  "agents": [
    {
      "id": "tutor",
      "slackBotToken": "$TUTOR_SLACK_BOT_TOKEN",
      "slackAppToken": "$TUTOR_SLACK_APP_TOKEN",
      "allowedUsers": ["U12345"]
    },
    {
      "id": "student-1",
      "linkedTutor": "tutor",
      "slackBotToken": "$STUDENT_SLACK_BOT_TOKEN",
      "slackAppToken": "$STUDENT_SLACK_APP_TOKEN",
      "helpLevel": "guided",
      "disallowedTools": ["bash", "write_file", "edit", "multi_edit"]
    }
  ]
}
```

`.env`:

```
TUTOR_SLACK_BOT_TOKEN=xoxb-...
TUTOR_SLACK_APP_TOKEN=xapp-...
STUDENT_SLACK_BOT_TOKEN=xoxb-...
STUDENT_SLACK_APP_TOKEN=xapp-...
ANTHROPIC_API_KEY=sk-ant-...
```

**Key agent options:**

| Option | Description | Default |
|--------|-------------|---------|
| `provider` | `anthropic-claude` or `openai-codex` | `anthropic-claude` |
| `helpLevel` | `hints` / `guided` / `full` -- academic integrity guardrail | `guided` |
| `maxToolIterations` | Max tool-use turns per request | 10 |
| `disallowedTools` | Tools to block (e.g. `["bash", "write_file"]`) | `[]` |
| `allowedUsers` | Slack user IDs permitted to interact | `[]` |
| `rateLimitPerMinute` | Max requests per user per minute | 20 |
| `quietHours` | Time range to suppress responses (e.g. `"23:00-07:00"`) | -- |

Config resolution: `CLAWARTS_CONFIG` env > `./config.json` > `~/.clawarts/config.json`.

## Tools

| Tool | Category | Typical access |
|------|----------|----------------|
| `read_file`, `write_file`, `edit`, `multi_edit` | filesystem | tutor |
| `bash` | shell | tutor |
| `web_search`, `web_fetch` | web | all |
| `relay`, `list_students` | communication | tutor |
| `assignment`, `grades` | academic | tutor |
| `submit`, `my_status` | academic | student |
| `checkin` | academic | tutor |
| `checkin_respond` | academic | student |
| `cron` | scheduling | tutor |
| `status` | utility | tutor |
| `help` | utility | all |
| `export_session`, `reset_session` | utility | all |

Tool access is controlled per agent via `allowedTools` / `disallowedTools` in config. Supports exact names, `category:web` syntax, and `web_*` wildcards.

## Skills

Skills are prompt-driven workflows defined in `SKILL.md` files. Invoked by name (e.g. "use the new_homework skill").

**Tutor:** `/new_homework`, `/launch_checkin`, `/check_submissions`, `/setup_course`, `/announcement`, `/progress`, `/roster`, `/export`, `/office_hours`, `/status`, `/help`

**Student:** `/my_assignments`, `/checkin`, `/my_grades`, `/remind`, `/office_hours`, `/help`

Skills live in `examples/default_tutor/skills/` and `examples/default_student/skills/`, copied to agent workspaces on first startup. Workspace skills override bundled ones.

## Workspace files

Each agent workspace can include these optional markdown files:

| File | Purpose |
|------|---------|
| `SOUL.md` | Agent persona and behavior guidelines |
| `IDENTITY.md` | Agent identity details |
| `AGENTS.md` | Multi-agent context (who else exists) |
| `TOOLS.md` | Tool usage guidance |
| `USER.md` | User-facing information |
| `COURSE.md` | Course schedule for `/setup_course` |

## Check-in modes

| Mode | How it works |
|------|-------------|
| `passphrase` | Students enter a secret phrase; auto-evaluated |
| `quiz` | Per-student questions on a topic; AI-evaluated |
| `pulse` | Repeated short check-ins at intervals |
| `reflect` | Open-ended reflection prompts |

## CLI

```bash
npm run cli setup          # full interactive setup
npm run cli agent add      # add an agent
npm run cli agent list     # list agents
npm run cli agent remove   # remove an agent
npm run cli skill add      # add a skill to an agent
npm run cli skill list     # list agent skills
npm run cli skill remove   # remove a skill
npm run check              # run diagnostics
```

## Development

```bash
npm run dev           # start with auto-reload (tsx --watch)
npm test              # run tests (vitest)
npm run test:watch    # watch mode
npm run typecheck     # tsc --noEmit
npm run build         # compile to dist/
```

## Data layout

```
~/.clawarts/
  config.json
  agents/{id}/
    workspace/        # SOUL.md, TOOLS.md, skills/
    data/             # assignments.json, submissions.json, checkins/
    cron/             # jobs.json
    sessions/         # persisted conversation history
```

## License

MIT
