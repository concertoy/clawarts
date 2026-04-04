# Clawarts

Multi-agent Slack bot for course management. TypeScript, Node.js, Socket Mode.

## Build & Check

```bash
npm run dev        # development (auto-reload)
npm start          # production
npx tsc --noEmit   # type check
```

## Architecture

- `src/index.ts` — entrypoint, agent creation, Slack app + cron startup
- `src/agent.ts` — agent loop (tool execution, compaction, streaming)
- `src/slack.ts` — Slack event handlers, session hydration, message dispatch
- `src/tools/` — per-category tool files (file, shell, web, academic)
- `src/providers/` — Claude and Codex provider implementations
- `src/cron/` — scheduled job service with precise setTimeout
- `src/relay.ts` — cross-agent messaging with broadcast
- `src/store/` — JSON file stores (assignments, submissions, check-ins)
- `src/skills.ts` — multi-source skill loader with precedence
- `examples/` — default tutor/student workspace templates and skills
