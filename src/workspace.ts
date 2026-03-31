import fs from "node:fs";
import path from "node:path";
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
];

const MAX_CHARS_PER_FILE = 20_000;

export function loadWorkspaceFiles(workspaceDir: string): WorkspaceFile[] {
  const files: WorkspaceFile[] = [];

  for (const name of BOOTSTRAP_FILES) {
    const filePath = path.join(workspaceDir, name);
    try {
      if (!fs.existsSync(filePath)) continue;
      let content = fs.readFileSync(filePath, "utf-8").trim();
      if (!content) continue;

      // Strip YAML frontmatter if present
      if (content.startsWith("---")) {
        const endIndex = content.indexOf("\n---", 3);
        if (endIndex !== -1) {
          content = content.slice(endIndex + 4).trim();
        }
      }

      // Trim to budget
      if (content.length > MAX_CHARS_PER_FILE) {
        const headLen = Math.floor(MAX_CHARS_PER_FILE * 0.7);
        const tailLen = Math.floor(MAX_CHARS_PER_FILE * 0.2);
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

  return files;
}
