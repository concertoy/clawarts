import type { Skill, WorkspaceFile } from "./types.js";
import { formatSkillsForPrompt } from "./skills.js";

export function buildSystemPrompt(params: {
  identity: string;
  skills: Skill[];
  workspaceFiles: WorkspaceFile[];
}): string {
  const sections: string[] = [];

  // Identity
  sections.push(params.identity);

  // Skills section (mirrors OpenClaw's buildSkillsSection)
  const skillsXml = formatSkillsForPrompt(params.skills);
  if (skillsXml) {
    sections.push(
      [
        "## Skills (mandatory)",
        'Before replying: scan <available_skills> <description> entries.',
        "- If exactly one skill clearly applies: read its SKILL.md at <location> with `read_file`, then follow it.",
        "- If multiple could apply: choose the most specific one, then read/follow it.",
        "- If none clearly apply: do not read any SKILL.md.",
        "Constraints: never read more than one skill up front; only read after selecting.",
        skillsXml,
      ].join("\n"),
    );
  }

  // Project Context — workspace files (SOUL.md, IDENTITY.md, AGENTS.md, etc.)
  if (params.workspaceFiles.length > 0) {
    const lines: string[] = ["# Project Context", ""];

    const hasSoul = params.workspaceFiles.some((f) => f.name.toLowerCase() === "soul.md");
    if (hasSoul) {
      lines.push(
        "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
        "",
      );
    }

    for (const file of params.workspaceFiles) {
      lines.push(`## ${file.name}`, "", file.content, "");
    }

    sections.push(lines.join("\n"));
  }

  // Current date
  sections.push(`Current date: ${new Date().toISOString().split("T")[0]}`);

  return sections.join("\n\n");
}
