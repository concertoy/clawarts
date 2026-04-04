import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEntry, RootConfig } from "../types.js";

/**
 * Config path resolution order:
 * 1. CLAWARTS_CONFIG env var (explicit override)
 * 2. ./config.json (CWD, for development)
 * 3. ~/.clawarts/config.json (canonical home-dir location)
 */
function resolveConfigPath(): string {
  if (process.env.CLAWARTS_CONFIG) return path.resolve(process.env.CLAWARTS_CONFIG);
  const cwdPath = path.resolve("config.json");
  try {
    fs.accessSync(cwdPath, fs.constants.R_OK);
    return cwdPath;
  } catch {
    return path.join(os.homedir(), ".clawarts", "config.json");
  }
}

const CONFIG_PATH = resolveConfigPath();

// ─── Read / Write ────────────────────────────────────────────────────

export function readConfig(): RootConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { defaults: {}, agents: [] };
    }
    throw err;
  }
  let parsed: Partial<RootConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<RootConfig>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${msg}`);
  }
  return {
    defaults: parsed.defaults ?? {},
    agents: parsed.agents ?? [],
  };
}

/**
 * Atomic write: write to temp file then rename.
 * Safe even if the bot process is reading config.json concurrently.
 */
export function writeConfig(config: RootConfig): void {
  const json = JSON.stringify(config, null, 2) + "\n";
  const tmp = CONFIG_PATH + `.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, json, "utf-8");
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

// ─── Agent CRUD ──────────────────────────────────────────────────────

export function findAgent(config: RootConfig, id: string): AgentEntry | undefined {
  return config.agents.find((a) => a.id === id);
}

export function addAgent(config: RootConfig, entry: AgentEntry): RootConfig {
  if (config.agents.some((a) => a.id === entry.id)) {
    throw new Error(`Agent "${entry.id}" already exists`);
  }
  return {
    ...config,
    agents: [...config.agents, entry],
  };
}

export function removeAgent(config: RootConfig, id: string): RootConfig {
  return {
    ...config,
    agents: config.agents.filter((a) => a.id !== id),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Derive env var name from agent ID.
 * e.g. "my-tutor" → "MY_TUTOR"
 */
export function agentIdToEnvPrefix(id: string): string {
  return id.replace(/-/g, "_").toUpperCase();
}

/**
 * Resolve workspace directory for an agent, matching config.ts logic.
 * Student agents linked to a tutor get a nested workspace: <tutor_workspace>/students/<student_id>/
 */
export function resolveWorkspaceDir(entry: AgentEntry, config?: RootConfig): string {
  // Explicit workspaceDir always wins
  if (entry.workspaceDir) {
    return entry.workspaceDir.startsWith("~/")
      ? path.join(os.homedir(), entry.workspaceDir.slice(2))
      : path.resolve(entry.workspaceDir);
  }

  // Student linked to a tutor → nested under tutor's workspace
  if (entry.linkedTutor && config) {
    const tutor = findAgent(config, entry.linkedTutor);
    if (tutor) {
      const tutorWorkspace = resolveWorkspaceDir(tutor);
      return path.join(tutorWorkspace, "students", entry.id);
    }
  }

  return path.join(os.homedir(), ".clawarts", "agents", entry.id, "workspace");
}

/**
 * Find all student agents linked to a given tutor.
 */
export function findLinkedStudents(config: RootConfig, tutorId: string): AgentEntry[] {
  return config.agents.filter((a) => a.linkedTutor === tutorId);
}

/**
 * Find all tutor agents (agents that have no linkedTutor and are not students).
 */
export function findTutors(config: RootConfig): AgentEntry[] {
  return config.agents.filter((a) => !a.linkedTutor);
}
