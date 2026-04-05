import type { ToolDefinition, ToolUseContext } from "../types.js";

/**
 * Help tool — lists available tools for the current agent.
 * Useful for students who don't know what they can do.
 */
export function createHelpTool(tools: ToolDefinition[]): ToolDefinition {
  return {
    name: "help",
    description: "List available tools and what they do.",
    parameters: { type: "object", properties: {} },
    isReadOnly: true,
    category: "utility",

    async execute(_input: Record<string, unknown>, _context?: ToolUseContext): Promise<string> {
      const lines = tools
        .filter((t) => t.name !== "help") // don't list ourselves
        .map((t) => {
          const desc = t.description || "No description";
          const firstSentence = desc.split(".")[0];
          const truncated = firstSentence.length > 120 ? firstSentence.slice(0, 117) + "..." : firstSentence;
          return `- **${t.name}**: ${truncated}.`;
        });

      return `Available tools (${lines.length}):\n${lines.join("\n")}`;
    },
  };
}
