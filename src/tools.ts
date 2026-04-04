import { setWorkspaceRoot } from "./tools/paths.js";
import { createFileTools } from "./tools/file-tools.js";
import { createShellTools } from "./tools/shell-tools.js";
import { createWebTools } from "./tools/web-tools.js";
import { createCronTool } from "./cron/tool.js";
import type { ToolDefinition } from "./types.js";
import type { CronService } from "./cron/service.js";

// ─── Registry ──────────────────────────────────────────────────────────

export function createToolRegistry(
  workspaceDir: string,
  opts?: { cronService?: CronService; agentId?: string },
): ToolDefinition[] {
  setWorkspaceRoot(workspaceDir);
  const tools: ToolDefinition[] = [
    ...createFileTools(),
    ...createShellTools(),
    ...createWebTools(),
  ];
  if (opts?.cronService && opts?.agentId) {
    tools.push(createCronTool(opts.cronService, opts.agentId));
  }
  return tools;
}

