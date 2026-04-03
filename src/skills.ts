import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type { Skill, SkillSources } from "./types.js";

// ─── Options ─────────────────────────────────────────────────────────

export interface SkillLoadOptions extends SkillSources {
  /** Backward-compat: flat list of dirs to scan (single-level). */
  legacyDirs?: string[];
}

// ─── Namespace derivation ────────────────────────────────────────────

/**
 * Derive a colon-separated namespace from a SKILL.md's directory relative to its root.
 * e.g. rootDir=/skills, skillDir=/skills/auth/login → "auth:login"
 * Top-level skills (skillDir === rootDir) return the directory name.
 */
function buildNamespace(skillDir: string, rootDir: string): string {
  const rel = path.relative(rootDir, skillDir);
  if (!rel || rel === ".") return path.basename(skillDir);
  return rel.split(path.sep).join(":");
}

// ─── Recursive scanner ──────────────────────────────────────────────

/**
 * Recursively scan a root directory for SKILL.md files.
 * Stops recursing into a directory once SKILL.md is found (leaf skill).
 */
function scanSkillsRecursive(
  rootDir: string,
  source: Skill["source"],
): Skill[] {
  const expanded = rootDir.startsWith("~/") ? path.join(os.homedir(), rootDir.slice(2)) : rootDir;
  const resolved = path.resolve(expanded);
  if (!fs.existsSync(resolved)) return [];

  const skills: Skill[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const skillPath = path.join(dir, "SKILL.md");
    if (fs.existsSync(skillPath)) {
      // This directory is a leaf skill — parse it, don't recurse deeper
      const skill = parseSkillFile(skillPath, dir, resolved, source);
      if (skill) skills.push(skill);
      return;
    }

    // No SKILL.md here — recurse into subdirectories
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        walk(path.join(dir, entry.name));
      }
    }
  }

  walk(resolved);
  return skills;
}

// ─── SKILL.md parser ────────────────────────────────────────────────

function parseSkillFile(
  skillPath: string,
  skillDir: string,
  rootDir: string,
  source: Skill["source"],
): Skill | null {
  try {
    const raw = fs.readFileSync(skillPath, "utf-8");
    const { data } = matter(raw);

    const namespace = buildNamespace(skillDir, rootDir);
    const name = (data.name as string) ?? namespace;
    const description = (data.description as string) ?? "";

    const skill: Skill = { name, description, filePath: skillPath, source };

    // Extended frontmatter fields
    if (data["allowed-tools"]) {
      const raw = data["allowed-tools"];
      skill.allowedTools = Array.isArray(raw)
        ? raw.map(String)
        : String(raw).split(",").map((s: string) => s.trim()).filter(Boolean);
    }
    if (data.when_to_use) skill.whenToUse = String(data.when_to_use);
    if (data.arguments) skill.arguments = String(data.arguments);

    return skill;
  } catch {
    console.warn(`[skills] Failed to parse ${skillPath}, skipping`);
    return null;
  }
}

// ─── Multi-source loader ────────────────────────────────────────────

/**
 * Load skills from multiple sources with precedence.
 * Later sources overwrite earlier ones by name (workspace > agent > user-global > bundled).
 * Deduplicates by realpath to avoid counting the same physical directory twice.
 */
export function loadSkills(options: SkillLoadOptions): Skill[] {
  const map = new Map<string, Skill>();
  const seen = new Set<string>(); // realpath dedup

  function addSource(dir: string | undefined, source: Skill["source"]) {
    if (!dir) return;
    const expanded = dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
    const resolved = path.resolve(expanded);
    if (!fs.existsSync(resolved)) return;

    let real: string;
    try { real = fs.realpathSync(resolved); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);

    for (const skill of scanSkillsRecursive(resolved, source)) {
      map.set(skill.name, skill);
    }
  }

  // Precedence order: bundled (lowest) → user-global → agent → workspace (highest)
  addSource(options.bundledDir, "bundled");
  addSource(options.userGlobalDir, "user-global");
  addSource(options.agentDir, "agent");
  addSource(options.workspaceDir, "workspace");

  // Legacy fallback: flat dirs from skillsDirs config
  if (options.legacyDirs) {
    for (const dir of options.legacyDirs) {
      const expanded = dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
      const resolved = path.resolve(expanded);
      if (!fs.existsSync(resolved)) continue;

      let real: string;
      try { real = fs.realpathSync(resolved); } catch { continue; }
      if (seen.has(real)) continue;
      seen.add(real);

      for (const skill of scanSkillsRecursive(resolved, "legacy")) {
        map.set(skill.name, skill);
      }
    }
  }

  return Array.from(map.values());
}

// ─── Prompt formatting ──────────────────────────────────────────────

export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const entries = skills
    .map((s) => {
      const lines = [
        "<skill>",
        `<name>${s.name}</name>`,
        `<description>${s.description}</description>`,
        `<location>${s.filePath}</location>`,
      ];
      if (s.whenToUse) lines.push(`<when_to_use>${s.whenToUse}</when_to_use>`);
      if (s.arguments) lines.push(`<arguments>${s.arguments}</arguments>`);
      if (s.allowedTools?.length) lines.push(`<allowed_tools>${s.allowedTools.join(", ")}</allowed_tools>`);
      lines.push("</skill>");
      return lines.join("\n");
    })
    .join("\n");

  return `<available_skills>\n${entries}\n</available_skills>`;
}
