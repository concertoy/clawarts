<p align="center">
  <img src="assets/badge.png" alt="clawarts" width="500">
</p>

<p align="center">
  <strong>Multi-agent Slack bot for course management.</strong><br>
  Tutor and student agents run independent AI loops, communicate via relay, and connect to Slack through Socket Mode.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/clawarts"><img src="https://img.shields.io/npm/v/clawarts?style=for-the-badge" alt="npm"></a>
  <a href="https://github.com/concertoy/clawarts/releases"><img src="https://img.shields.io/github/v/release/concertoy/clawarts?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/7nBpZ7HHME"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

---

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

## License

MIT License &copy; 2026 [Tianzhe Chu](https://tianzhechu.com)
