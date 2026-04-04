import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { WorkspaceFile } from "./types.js";
import { errMsg, isFileNotFound } from "./utils/errors.js";

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

const cache = new Map<string, { files: WorkspaceFile[]; mtimeMs: number; fileCount: number }>();

/** Get the max mtime and count of existing bootstrap files. */
function getBootstrapStats(workspaceDir: string): { maxMtime: number; fileCount: number } {
  let max = 0;
  let count = 0;
  for (const name of BOOTSTRAP_FILES) {
    try {
      const stat = fs.statSync(path.join(workspaceDir, name));
      if (stat.mtimeMs > max) max = stat.mtimeMs;
      count++;
    } catch (err) {
      // ENOENT is expected for missing bootstrap files; warn on real errors (e.g. EACCES)
      if (!isFileNotFound(err)) {
        console.warn(`[workspace] Failed to stat ${name}:`, errMsg(err));
      }
    }
  }
  return { maxMtime: max, fileCount: count };
}

export function loadWorkspaceFiles(workspaceDir: string): WorkspaceFile[] {
  const { maxMtime: mtime, fileCount } = getBootstrapStats(workspaceDir);
  const cached = cache.get(workspaceDir);
  // Invalidate cache if mtime changed OR file count changed (detects deletions)
  if (cached && cached.mtimeMs >= mtime && cached.fileCount === fileCount && mtime > 0) {
    return cached.files;
  }
  const files: WorkspaceFile[] = [];

  for (const name of BOOTSTRAP_FILES) {
    const filePath = path.join(workspaceDir, name);
    try {
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
    } catch (err) {
      // ENOENT is expected for missing bootstrap files — only warn on real errors
      if (isFileNotFound(err)) continue;
      console.warn(`[workspace] Failed to read ${name}:`, errMsg(err));
    }
  }

  if (files.length > 0) {
    console.log(`[workspace] Loaded ${files.length} file(s): ${files.map((f) => f.name).join(", ")}`);
  }

  cache.set(workspaceDir, { files, mtimeMs: mtime || Date.now(), fileCount });
  return files;
}
