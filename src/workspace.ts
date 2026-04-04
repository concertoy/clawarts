import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { WorkspaceFile } from "./types.js";

/**
 * Bootstrap files loaded from the workspace directory, following OpenClaw's pattern.
 * SOUL.md gets special treatment in the system prompt.
 */
const BOOTSTRAP_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "AGENTS.md",
  "TOOLS.md",
  "USER.md",
  "COURSE.md",
];

const MAX_CHARS_PER_FILE = 20_000;
const CACHE_TTL_MS = 60_000; // 60s — workspace files change rarely

const cache = new Map<string, { files: WorkspaceFile[]; loadedAt: number }>();

export function loadWorkspaceFiles(workspaceDir: string): WorkspaceFile[] {
  const cached = cache.get(workspaceDir);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.files;
  }
  const files: WorkspaceFile[] = [];

  for (const name of BOOTSTRAP_FILES) {
    const filePath = path.join(workspaceDir, name);
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, "utf-8").trim();
      if (!raw) continue;

      // Strip YAML frontmatter using gray-matter (handles edge cases like --- in code blocks)
      let content = matter(raw).content.trim();

      // Trim to budget
      if (content.length > MAX_CHARS_PER_FILE) {
        const headLen = Math.floor(MAX_CHARS_PER_FILE * 0.75);
        const tailLen = Math.floor(MAX_CHARS_PER_FILE * 0.25);
        content =
          content.slice(0, headLen) +
          `\n\n[...truncated, read ${name} for full content...]\n\n` +
          content.slice(-tailLen);
      }

      files.push({ name, content });
    } catch {
      // Skip unreadable files
    }
  }

  if (files.length > 0) {
    console.log(`[workspace] Loaded ${files.length} file(s): ${files.map((f) => f.name).join(", ")}`);
  }

  cache.set(workspaceDir, { files, loadedAt: Date.now() });
  return files;
}
