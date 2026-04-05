import type { AgentConfig, ToolDefinition } from "./types.js";

/**
 * Filter tools for a specific agent based on its config.
 * Ported from claude-code's getTools() + filterToolsByDenyRules() pattern.
 *
 * Filtering pipeline (in order):
 * 1. isEnabled() — runtime gate on each tool
 * 2. allowedTools — if set, only these tools (or categories) pass
 * 3. disallowedTools — these tools (or categories) are removed
 */
export function filterToolsForAgent(
  allTools: ToolDefinition[],
  config: AgentConfig,
): ToolDefinition[] {
  let tools = allTools;

  // Step 1: Runtime gate — ported from claude-code's tool.isEnabled() check
  tools = tools.filter((t) => !t.isEnabled || t.isEnabled());

  // Step 2: Allowlist — if specified, only matching tools pass
  if (config.allowedTools && config.allowedTools.length > 0) {
    const allowed = new Set(config.allowedTools);
    tools = tools.filter((t) => matchesToolFilter(t, allowed));
  }

  // Step 3: Denylist — remove matching tools
  if (config.disallowedTools && config.disallowedTools.length > 0) {
    const denied = new Set(config.disallowedTools);
    tools = tools.filter((t) => !matchesToolFilter(t, denied));
  }

  return tools;
}

/**
 * Check if a tool matches any entry in a filter set.
 * Supports matching by exact tool name or by category prefix (e.g. "category:web").
 */
function matchesToolFilter(tool: ToolDefinition, filterSet: Set<string>): boolean {
  // Match by exact name
  if (filterSet.has(tool.name)) return true;

  // Match by category (e.g. "category:web" matches all tools with category "web")
  if (tool.category) {
    if (filterSet.has(`category:${tool.category}`)) return true;
  }

  // Match by wildcard pattern (e.g. "web_*" matches "web_search", "web_fetch")
  for (const pattern of filterSet) {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      // "*" alone matches everything; "web_*" matches tools starting with "web_"
      if (prefix === "" || tool.name.startsWith(prefix)) return true;
    }
  }

  return false;
}
