import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentType } from "./templates.js";
import { errMsg, isFileNotFound } from "../utils/errors.js";

// ─── Example template resolution ────────────────────────────────────

/** Package root — anchored to this source file, not process.cwd(). */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Resolve the example template directory for an agent type.
 * Templates live in examples/default_tutor/ and examples/default_student/.
 */
function resolveTemplateDir(agentType: AgentType): string {
  const dirName = agentType === "student" ? "default_student" : "default_tutor";
  // Try package-relative first, fall back to CWD-relative for development
  const pkgPath = path.join(PKG_ROOT, "examples", dirName);
  if (fs.existsSync(pkgPath)) return pkgPath;
  return path.resolve("examples", dirName);
}

/** Read a template file and replace {{AGENT_ID}} placeholders. */
function readTemplate(templateDir: string, fileName: string, agentId: string): string | null {
  const filePath = path.join(templateDir, fileName);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.replace(/\{\{AGENT_ID\}\}/g, agentId);
  } catch (err) {
    // ENOENT is expected when template file doesn't exist
    if (isFileNotFound(err)) return null;
    console.warn(`[scaffold] Failed to read template ${fileName}:`, errMsg(err));
    return null;
  }
}

// ─── Scaffold ────────────────────────────────────────────────────────

const TEMPLATE_FILES = ["SOUL.md", "IDENTITY.md", "AGENTS.md", "TOOLS.md", "USER.md", "COURSE.md"] as const;

/**
 * Create workspace directory structure and template files for a new agent.
 * Copies from examples/default_tutor/ or examples/default_student/.
 * Falls back to inline defaults if example files are missing.
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

  const templateDir = resolveTemplateDir(agentType);

  // Write template files
  for (const fileName of TEMPLATE_FILES) {
    const filePath = path.join(workspaceDir, fileName);
    if (fs.existsSync(filePath)) {
      skipped.push(fileName);
      continue;
    }

    const content = readTemplate(templateDir, fileName, agentId);
    if (content) {
      fs.writeFileSync(filePath, content, "utf-8");
    } else {
      // Fallback: minimal inline content if example file is missing
      fs.writeFileSync(filePath, `# ${fileName.replace(".md", "")}\n`, "utf-8");
    }
    created.push(fileName);
  }

  // Copy example skills into the workspace skills directory
  const exampleSkillsDir = path.join(templateDir, "skills");
  if (fs.existsSync(exampleSkillsDir)) {
    const destSkillsDir = path.join(workspaceDir, "skills");
    copyDirRecursive(exampleSkillsDir, destSkillsDir, agentId, created, skipped);
  }

  return { created, skipped };
}

/** Recursively copy a directory, replacing {{AGENT_ID}} in file contents. Skips existing files. */
function copyDirRecursive(src: string, dest: string, agentId: string, created: string[], skipped: string[]): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirRecursive(srcPath, destPath, agentId, created, skipped);
    } else {
      const label = `skills/${path.relative(dest, destPath).replace(/\\/g, "/")}`;
      if (fs.existsSync(destPath)) {
        skipped.push(label);
        continue;
      }
      const content = fs.readFileSync(srcPath, "utf-8").replace(/\{\{AGENT_ID\}\}/g, agentId);
      fs.writeFileSync(destPath, content, "utf-8");
      created.push(label);
    }
  }
}
