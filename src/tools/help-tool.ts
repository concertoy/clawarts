import type { ToolDefinition, ToolUseContext } from "../types.js";

/**
 * Help tool — lists available tools for the current agent.
 * Useful for students who don't know what they can do.
 */
export function createHelpTool(tools: ToolDefinition[]): ToolDefinition {
  return {
    name: "help",
    description: "List available tools and what they do. Optionally filter by category.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Filter tools by category (e.g. 'academic', 'filesystem', 'web', 'shell', 'search', 'utility')",
        },
      },
    },
    isReadOnly: true,
    category: "utility",

    async execute(input: Record<string, unknown>, _context?: ToolUseContext): Promise<string> {
      const categoryFilter = typeof input.category === "string" ? input.category.toLowerCase() : undefined;
      const filtered = tools.filter((t) => {
        if (t.name === "help") return false;
        if (categoryFilter && t.category?.toLowerCase() !== categoryFilter) return false;
        return true;
      });

      const lines = filtered.map((t) => {
        const desc = t.description || "No description";
        // Split at ". " (sentence boundary) not "." to avoid cutting "e.g." or "v1.2"
        const firstSentence = desc.includes(". ") ? desc.slice(0, desc.indexOf(". ") + 1) : desc;
        const truncated = firstSentence.length > 120 ? firstSentence.slice(0, 117) + "..." : firstSentence;
        const cat = t.category ? ` [${t.category}]` : "";
        return `- **${t.name}**${cat}: ${truncated}`;
      });

      // Show available categories as a hint
      const categories = [...new Set(tools.filter((t) => t.name !== "help" && t.category).map((t) => t.category!))].sort();
      const header = categoryFilter
        ? `Tools in "${categoryFilter}" (${lines.length}):`
        : `Available tools (${lines.length}):`;
      const footer = !categoryFilter && categories.length > 1
        ? `\nCategories: ${categories.join(", ")}`
        : "";

      return `${header}\n${lines.join("\n")}${footer}`;
    },
  };
}
