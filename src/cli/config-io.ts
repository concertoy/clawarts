import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEntry, RootConfig } from "../types.js";

const CONFIG_PATH = path.resolve("config.json");

// ─── Read / Write ────────────────────────────────────────────────────

export function readConfig(): RootConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { defaults: {}, agents: [] };
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw) as Partial<RootConfig>;
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
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, json, "utf-8");
  fs.renameSync(tmp, CONFIG_PATH);
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
 */
export function resolveWorkspaceDir(entry: AgentEntry): string {
  if (entry.workspaceDir) {
    return entry.workspaceDir.startsWith("~/")
      ? path.join(os.homedir(), entry.workspaceDir.slice(2))
      : path.resolve(entry.workspaceDir);
  }
  return path.join(os.homedir(), ".clawarts", "agents", entry.id, "workspace");
}
