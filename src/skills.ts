import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type { Skill } from "./types.js";

export function loadSkills(skillsDirs: string[]): Skill[] {
  const skills: Skill[] = [];

  for (const dir of skillsDirs) {
    const expanded = dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
    const resolved = path.resolve(expanded);
    if (!fs.existsSync(resolved)) continue;

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = path.join(resolved, entry.name, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;

      try {
        const raw = fs.readFileSync(skillPath, "utf-8");
        const { data } = matter(raw);

        skills.push({
          name: (data.name as string) ?? entry.name,
          description: (data.description as string) ?? "",
          filePath: skillPath,
        });
      } catch {
        console.warn(`[skills] Failed to parse ${skillPath}, skipping`);
      }
    }
  }

  return skills;
}

export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const entries = skills
    .map(
      (s) =>
        `<skill>\n<name>${s.name}</name>\n<description>${s.description}</description>\n<location>${s.filePath}</location>\n</skill>`,
    )
    .join("\n");

  return `<available_skills>\n${entries}\n</available_skills>`;
}
