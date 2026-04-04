import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { resolveFilePath, workspaceRoot, errMsg } from "./paths.js";

// ─── read_file ─────────────────────────────────────────────────────────

const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "Read the contents of a file. Supports absolute paths, ~/paths, and paths relative to the workspace directory. Use offset/limit to read specific line ranges.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file path to read." },
      offset: { type: "number", description: "Line number to start reading from (0-based). Default: 0." },
      limit: { type: "number", description: "Maximum number of lines to read. Default: all." },
    },
    required: ["path"],
  },
  isReadOnly: true,
  category: "filesystem",
  async execute(input) {
    const filePath = resolveFilePath(input.path as string);
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const offset = (input.offset as number) ?? 0;
      const limit = (input.limit as number) ?? lines.length;
      const slice = lines.slice(offset, offset + limit);
      const result = slice.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
      const maxChars = 100_000;
      if (result.length > maxChars) {
        return result.slice(0, maxChars) + `\n\n[Truncated: file is ${lines.length} lines]`;
      }
      return result;
    } catch (err) {
      return `Error reading file: ${errMsg(err)}`;
    }
  },
};

// ─── write_file ────────────────────────────────────────────────────────

const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "Write content to a file within the workspace directory. Creates parent directories if needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to workspace, or absolute path within it." },
      content: { type: "string", description: "The content to write." },
    },
    required: ["path", "content"],
  },
  category: "filesystem",
  async execute(input) {
    const filePath = resolveFilePath(input.path as string);
    const content = input.content as string;

    const resolvedWorkspace = path.resolve(workspaceRoot);
    if (!filePath.startsWith(resolvedWorkspace + path.sep) && filePath !== resolvedWorkspace) {
      return `Error: write_file is restricted to the workspace directory (${resolvedWorkspace}). Path "${filePath}" is outside the workspace.`;
    }

    try {
      const dir = path.dirname(filePath);
      await fs.promises.mkdir(dir, { recursive: true });
      // Atomic write: temp file + rename to prevent corruption on crash
      const tmp = filePath + `.tmp.${process.pid}`;
      try {
        await fs.promises.writeFile(tmp, content, "utf-8");
        await fs.promises.rename(tmp, filePath);
      } catch (err) {
        await fs.promises.unlink(tmp).catch(() => {});
        return `Error writing file: ${errMsg(err)}`;
      }
      return `File written: ${filePath}`;
    } catch (err) {
      return `Error writing file: ${errMsg(err)}`;
    }
  },
};

// ─── edit ──────────────────────────────────────────────────────────────

const editTool: ToolDefinition = {
  name: "edit",
  description:
    "Edit a file by replacing an exact text match. The oldText must match exactly (including whitespace). Works on files within the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit." },
      oldText: { type: "string", description: "Exact text to find in the file." },
      newText: { type: "string", description: "Text to replace it with." },
    },
    required: ["path", "oldText", "newText"],
  },
  category: "filesystem",
  async execute(input) {
    const filePath = resolveFilePath(input.path as string);
    const oldText = input.oldText as string;
    const newText = input.newText as string;

    const resolvedWorkspace = path.resolve(workspaceRoot);
    if (!filePath.startsWith(resolvedWorkspace + path.sep) && filePath !== resolvedWorkspace) {
      return `Error: edit is restricted to the workspace directory (${resolvedWorkspace}).`;
    }

    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const idx = content.indexOf(oldText);
      if (idx === -1) return `Error: oldText not found in ${filePath}`;

      const secondIdx = content.indexOf(oldText, idx + 1);
      if (secondIdx !== -1) return `Error: oldText matches multiple locations in ${filePath}. Provide more context to make it unique.`;

      const updated = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
      const tmp = filePath + `.tmp.${process.pid}`;
      try {
        await fs.promises.writeFile(tmp, updated, "utf-8");
        await fs.promises.rename(tmp, filePath);
      } catch (err) {
        await fs.promises.unlink(tmp).catch(() => {});
        return `Error editing file: ${errMsg(err)}`;
      }

      const lineNum = content.slice(0, idx).split("\n").length;
      return `Edited ${filePath} at line ${lineNum}`;
    } catch (err) {
      return `Error editing file: ${errMsg(err)}`;
    }
  },
};

// ─── multi_edit (batch edits in one call) ─────────────────────────────

const multiEditTool: ToolDefinition = {
  name: "multi_edit",
  description:
    "Apply multiple edits to a single file in one call. Each edit replaces an exact text match. Edits are applied sequentially. More efficient than multiple edit calls.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit." },
      edits: {
        type: "array",
        description: "Array of edits to apply, each with oldText and newText.",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "Exact text to find." },
            newText: { type: "string", description: "Text to replace it with." },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
  },
  category: "filesystem",
  async execute(input) {
    const filePath = resolveFilePath(input.path as string);
    const edits = input.edits as Array<{ oldText: string; newText: string }>;

    if (!edits || edits.length === 0) return "Error: edits array is empty.";

    const resolvedWorkspace = path.resolve(workspaceRoot);
    if (!filePath.startsWith(resolvedWorkspace + path.sep) && filePath !== resolvedWorkspace) {
      return `Error: multi_edit is restricted to the workspace directory (${resolvedWorkspace}).`;
    }

    try {
      let content = await fs.promises.readFile(filePath, "utf-8");
      const results: string[] = [];

      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
          results.push(`Edit ${i + 1}: invalid entry (missing oldText or newText) — skipped`);
          continue;
        }
        const { oldText, newText } = edit;
        const idx = content.indexOf(oldText);
        if (idx === -1) {
          results.push(`Edit ${i + 1}: oldText not found — skipped`);
          continue;
        }

        const secondIdx = content.indexOf(oldText, idx + 1);
        if (secondIdx !== -1) {
          results.push(`Edit ${i + 1}: oldText matches multiple locations — skipped`);
          continue;
        }

        const lineNum = content.slice(0, idx).split("\n").length;
        content = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
        results.push(`Edit ${i + 1}: applied at line ${lineNum}`);
      }

      const tmp = filePath + `.tmp.${process.pid}`;
      try {
        await fs.promises.writeFile(tmp, content, "utf-8");
        await fs.promises.rename(tmp, filePath);
      } catch (err) {
        await fs.promises.unlink(tmp).catch(() => {});
        return `Error in multi_edit: ${errMsg(err)}`;
      }
      return `Multi-edit ${filePath}:\n${results.join("\n")}`;
    } catch (err) {
      return `Error in multi_edit: ${errMsg(err)}`;
    }
  },
};

// ─── ls ────────────────────────────────────────────────────────────────

const lsTool: ToolDefinition = {
  name: "ls",
  description:
    "List directory contents. Shows files and directories with type indicators. Defaults to workspace root.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path to list. Default: workspace root." },
    },
    required: [],
  },
  isReadOnly: true,
  category: "filesystem",
  async execute(input) {
    const dirPath = input.path ? resolveFilePath(input.path as string) : workspaceRoot;

    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      if (entries.length === 0) return "(empty directory)";

      const lines = entries
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        })
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));

      if (lines.length > 200) {
        return lines.slice(0, 200).join("\n") + `\n\n[Truncated: ${lines.length} total entries]`;
      }
      return lines.join("\n");
    } catch (err) {
      return `Error listing directory: ${errMsg(err)}`;
    }
  },
};

// ─── Export ───────────────────────────────────────────────────────────

export function createFileTools(): ToolDefinition[] {
  return [readFileTool, writeFileTool, editTool, multiEditTool, lsTool];
}
