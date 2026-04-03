import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentType } from "./templates.js";

// ─── Workspace template content ──────────────────────────────────────

function soulContent(agentType: AgentType): string {
  if (agentType === "tutor") {
    return [
      "# Soul",
      "",
      "You are a knowledgeable and approachable tutor.",
      "Your tone is encouraging, patient, and precise.",
      "You explain concepts step-by-step, using analogies and examples to make ideas stick.",
      "When a student struggles, you adjust your approach rather than repeating the same explanation.",
      "You celebrate progress and treat mistakes as learning opportunities.",
    ].join("\n");
  }
  if (agentType === "student") {
    return [
      "# Soul",
      "",
      "You are a supportive study companion.",
      "Your tone is curious, collaborative, and upbeat.",
      "You ask clarifying questions to help the student think through problems on their own.",
      "You focus on building understanding, not just getting the right answer.",
      "You encourage the student to explain their reasoning out loud.",
    ].join("\n");
  }
  return [
    "# Soul",
    "",
    "You are a helpful assistant in a Slack workspace.",
    "Be clear, concise, and helpful.",
  ].join("\n");
}

function identityContent(agentId: string, agentType: AgentType): string {
  const role = agentType === "tutor" ? "Course Tutor" : agentType === "student" ? "Study Companion" : "Assistant";
  return [
    "# Identity",
    "",
    `- **Name:** ${agentId}`,
    `- **Role:** ${role}`,
  ].join("\n");
}

function agentsContent(): string {
  return [
    "# Agents",
    "",
    "This workspace may have multiple agents. Each agent has its own role and tools.",
    "Coordinate with other agents when tasks cross boundaries.",
  ].join("\n");
}

function toolsContent(agentType: AgentType): string {
  if (agentType === "student") {
    return [
      "# Tools",
      "",
      "You have read-only access to the workspace:",
      "- `read_file` — Read file contents",
      "- `grep` — Search file contents",
      "- `glob` — Find files by pattern",
      "- `ls` — List directory contents",
      "- `web_search` — Search the web",
      "- `web_fetch` — Fetch web page content",
      "",
      "You do NOT have access to: `bash`, `write_file`, `edit`, `multi_edit`.",
    ].join("\n");
  }
  return [
    "# Tools",
    "",
    "You have full access to workspace tools:",
    "- File operations: `read_file`, `write_file`, `edit`, `multi_edit`",
    "- Shell: `bash`",
    "- Search: `grep`, `glob`, `ls`",
    "- Web: `web_search`, `web_fetch`",
    "- Scheduling: `cron`",
  ].join("\n");
}

function userContent(): string {
  return [
    "# User",
    "",
    "<!-- Add information about the user here: name, timezone, preferences, etc. -->",
  ].join("\n");
}

// ─── Scaffold ────────────────────────────────────────────────────────

const TEMPLATE_FILES: Array<{ name: string; content: (id: string, type: AgentType) => string }> = [
  { name: "SOUL.md", content: (_id, type) => soulContent(type) },
  { name: "IDENTITY.md", content: (id, type) => identityContent(id, type) },
  { name: "AGENTS.md", content: () => agentsContent() },
  { name: "TOOLS.md", content: (_id, type) => toolsContent(type) },
  { name: "USER.md", content: () => userContent() },
];

/**
 * Create workspace directory structure and template files for a new agent.
 * Idempotent: skips files that already exist.
 */
export function scaffoldWorkspace(
  agentId: string,
  workspaceDir: string,
  agentType: AgentType,
): { created: string[]; skipped: string[] } {
  const created: string[] = [];
  const skipped: string[] = [];

  // Create workspace and skills subdirectory
  fs.mkdirSync(path.join(workspaceDir, "skills"), { recursive: true });

  // Create agent-level skills directory (~/.clawarts/agents/<id>/skills)
  const agentSkillsDir = path.join(os.homedir(), ".clawarts", "agents", agentId, "skills");
  fs.mkdirSync(agentSkillsDir, { recursive: true });

  // Write template files
  for (const tmpl of TEMPLATE_FILES) {
    const filePath = path.join(workspaceDir, tmpl.name);
    if (fs.existsSync(filePath)) {
      skipped.push(tmpl.name);
      continue;
    }
    fs.writeFileSync(filePath, tmpl.content(agentId, agentType) + "\n", "utf-8");
    created.push(tmpl.name);
  }

  return { created, skipped };
}
