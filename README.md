<p align="center">
  <strong>clawarts</strong><br>
  Multi-agent Slack bot for course management.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/clawarts"><img src="https://img.shields.io/npm/v/clawarts?style=for-the-badge" alt="npm"></a>
  <a href="https://github.com/concertoy/clawarts/releases"><img src="https://img.shields.io/github/v/release/concertoy/clawarts?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

---

Tutor and student agents run independent AI loops, communicate via relay, and connect to Slack through Socket Mode.

```
Tutor Agent ──relay/broadcast──> Student Agent(s)
     |                                |
     |-- assignments, check-ins       |-- submissions, responses
     |-- announcements, grades        |-- guided learning (helpLevel)
     '-- full tool access             '-- restricted tools
```

## Getting Started

```bash
curl -fsSL https://raw.githubusercontent.com/concertoy/clawarts/main/install.sh | bash
clawarts setup
clawarts
```

Or with npm:

```bash
npm install -g clawarts
clawarts setup
clawarts
```

## Documentation

| Topic | Description |
|---|---|
| [Installation](docs/installation.mdx) | curl, npm, or from source |
| [Quick Start](docs/quickstart.mdx) | Setup wizard walkthrough |
| [Configuration](docs/configuration.mdx) | config.json and all settings |
| [Agents](docs/agents.mdx) | Tutor/student roles, helpLevel |
| [Providers](docs/providers.mdx) | OpenAI Codex and Anthropic Claude |
| [Tools](docs/tools.mdx) | Built-in tools and access control |
| [Skills](docs/skills.mdx) | Prompt-driven workflows (SKILL.md) |
| [Workspace Files](docs/workspace-files.mdx) | SOUL.md, COURSE.md, etc. |
| [Check-ins](docs/check-ins.mdx) | Attendance: passphrase, quiz, pulse, reflect |
| [Assignments](docs/assignments.mdx) | Homework, submissions, grading |
| [Relay](docs/relay.mdx) | Cross-agent messaging and broadcast |
| [Scheduling](docs/scheduling.mdx) | Cron jobs and reminders |
| [CLI](docs/cli.mdx) | Command-line reference |
| [Architecture](docs/architecture.mdx) | Internals and data layout |

## License

MIT License &copy; 2026 [Tianzhe Chu](https://tianzhechu.com)
