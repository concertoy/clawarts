import { setWorkspaceRoot } from "./tools/paths.js";
import { createFileTools } from "./tools/file-tools.js";
import { createShellTools } from "./tools/shell-tools.js";
import { createWebTools } from "./tools/web-tools.js";
import { createCronTool } from "./cron/tool.js";
import type { ToolDefinition } from "./types.js";
import type { CronService } from "./cron/service.js";
import type { ToolUseContext } from "./types.js";
import { errMsg } from "./tools/paths.js";

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

// ─── Execute ───────────────────────────────────────────────────────────

export async function executeTool(
  tools: ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
  context?: ToolUseContext,
): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `Unknown tool: ${name}`;
  try {
    return await tool.execute(input, context);
  } catch (err) {
    return `Tool execution error: ${errMsg(err)}`;
  }
}
