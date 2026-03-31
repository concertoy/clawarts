import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "./types.js";

let workspaceRoot = "";

const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "Read the contents of a file. Supports absolute paths, ~/paths, and paths relative to the workspace directory.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The file path to read.",
      },
    },
    required: ["path"],
  },
  async execute(input) {
    let filePath = resolveFilePath(input.path as string);

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const maxChars = 100_000;
      if (content.length > maxChars) {
        return content.slice(0, maxChars) + `\n\n[Truncated: file is ${content.length} chars]`;
      }
      return content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error reading file: ${message}`;
    }
  },
};

const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "Write content to a file within the workspace directory. Creates parent directories if needed.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to the workspace directory, or absolute path within it.",
      },
      content: {
        type: "string",
        description: "The content to write.",
      },
    },
    required: ["path", "content"],
  },
  async execute(input) {
    const filePath = resolveFilePath(input.path as string);
    const content = input.content as string;

    // Enforce workspace boundary for writes
    const resolvedWorkspace = path.resolve(workspaceRoot);
    if (!filePath.startsWith(resolvedWorkspace + path.sep) && filePath !== resolvedWorkspace) {
      return `Error: write_file is restricted to the workspace directory (${resolvedWorkspace}). Path "${filePath}" is outside the workspace.`;
    }

    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, content, "utf-8");
      return `File written: ${filePath}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error writing file: ${message}`;
    }
  },
};

const webSearchTool: ToolDefinition = {
  name: "web_search",
  description: "Search the web for information. Returns search results as text.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query.",
      },
    },
    required: ["query"],
  },
  async execute(input) {
    const query = input.query as string;
    return `[web_search is not yet configured. Query was: "${query}"]`;
  },
};

export function createToolRegistry(workspaceDir: string): ToolDefinition[] {
  workspaceRoot = workspaceDir;
  return [readFileTool, writeFileTool, webSearchTool];
}

export async function executeTool(
  tools: ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return `Unknown tool: ${name}`;
  }
  try {
    return await tool.execute(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Tool execution error: ${message}`;
  }
}

function resolveFilePath(filePath: string): string {
  // Resolve ~ to home directory
  if (filePath.startsWith("~/")) {
    return path.resolve(path.join(process.env.HOME ?? "", filePath.slice(2)));
  }
  // Absolute paths stay as-is
  if (path.isAbsolute(filePath)) {
    return path.resolve(filePath);
  }
  // Relative paths resolve from workspace
  return path.resolve(workspaceRoot, filePath);
}
