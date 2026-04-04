import type { ToolDefinition } from "../types.js";
import { execAsync } from "../utils/exec-async.js";
import { resolveFilePath, workspaceRoot, errMsg } from "./paths.js";

/** Shell-safe quoting: wraps value in single quotes, escaping any embedded single quotes. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ─── bash ──────────────────────────────────────────────────────────────

/**
 * Dangerous command patterns — ported from claude-code's bashSecurity.ts.
 * These patterns are blocked to prevent catastrophic operations.
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,     // rm -rf /
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~\/)\*/, // rm -rf /* or ~/*
  /\bmkfs\b/,                                       // mkfs (format disk)
  /\bdd\s+.*\bof=\/dev\//,                          // dd to device
  /\b(shutdown|reboot|halt|poweroff)\b/,             // system control
  /\b(systemctl|service)\s+(stop|restart|disable)\b/, // service control
  />\s*\/dev\/sd[a-z]/,                              // write to block device
  /\bchmod\s+(-R\s+)?777\s+\//,                    // chmod 777 /
  /\bchown\s+(-R\s+)?.*\s+\//,                     // chown -R on /
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/,            // fork bomb
  /\biptables\s+(-F|--flush)\b/,                    // flush firewall
  /\bcurl\b.*\|\s*(sudo\s+)?(ba)?sh/,              // curl | sh
  /\bwget\b.*\|\s*(sudo\s+)?(ba)?sh/,              // wget | sh
];

function isDangerousCommand(command: string): string | null {
  const trimmed = command.trim();
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return `Blocked: command matches dangerous pattern (${pattern.source.slice(0, 40)}...). Use a safer alternative.`;
    }
  }
  return null;
}

const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Execute a shell command in the workspace directory. Returns stdout and stderr. Use timeout to limit long-running commands. Some dangerous commands (rm -rf /, mkfs, dd to devices, curl|sh) are blocked.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      timeout: { type: "number", description: "Timeout in milliseconds. Default: 30000 (30s)." },
    },
    required: ["command"],
  },
  category: "shell",
  async execute(input) {
    const command = input.command as string;
    const timeout = (input.timeout as number) ?? 30_000;

    // Safety check — ported from claude-code's bashSecurity.ts
    const blocked = isDangerousCommand(command);
    if (blocked) return blocked;

    try {
      const result = await execAsync(command, { cwd: workspaceRoot, timeout });
      const output = result.stdout || result.stderr || "(no output)";
      const maxChars = 100_000;

      if (result.exitCode !== 0 && result.exitCode !== null) {
        const combined = `Exit code: ${result.exitCode}\n${result.stdout}\n${result.stderr}`.trim();
        return combined.length > maxChars ? combined.slice(0, maxChars) + "\n\n[Truncated]" : combined;
      }

      return output.length > maxChars ? output.slice(0, maxChars) + "\n\n[Truncated]" : output;
    } catch (err) {
      return `Error executing command: ${errMsg(err)}`;
    }
  },
};

// ─── grep (ripgrep-based with fallback) ───────────────────────────────

let hasRipgrep: boolean | null = null;

async function detectRipgrep(): Promise<boolean> {
  if (hasRipgrep !== null) return hasRipgrep;
  try {
    const result = await execAsync("which rg", { timeout: 5_000 });
    hasRipgrep = result.exitCode === 0;
  } catch {
    hasRipgrep = false;
  }
  return hasRipgrep;
}

const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents using a regex pattern. Uses ripgrep if available, falls back to system grep. Supports output modes and pagination.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for." },
      path: { type: "string", description: "Directory or file to search in. Default: workspace root." },
      glob: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts')." },
      ignoreCase: { type: "boolean", description: "Case-insensitive search. Default: false." },
      outputMode: {
        type: "string",
        description: 'Output mode: "content" (default, shows matching lines), "files_with_matches" (just file paths), "count" (match counts).',
        enum: ["content", "files_with_matches", "count"],
      },
      headLimit: { type: "number", description: "Limit output to first N lines. Default: 250." },
      type: { type: "string", description: "File type for ripgrep (e.g. 'ts', 'py', 'js')." },
      multiline: { type: "boolean", description: "Enable multiline matching (ripgrep only). Default: false." },
    },
    required: ["pattern"],
  },
  isReadOnly: true,
  category: "search",
  async execute(input) {
    const pattern = input.pattern as string;
    const searchPath = input.path ? resolveFilePath(input.path as string) : workspaceRoot;
    const glob = input.glob as string | undefined;
    const ignoreCase = input.ignoreCase as boolean | undefined;
    const outputMode = (input.outputMode as string) ?? "content";
    const headLimit = (input.headLimit as number) ?? 250;
    const fileType = input.type as string | undefined;
    const multiline = input.multiline as boolean | undefined;

    const useRg = await detectRipgrep();

    try {
      let command: string;

      if (useRg) {
        // Ripgrep command — ported from claude-code GrepTool
        const args = ["rg"];
        if (ignoreCase) args.push("-i");
        if (multiline) args.push("-U", "--multiline-dotall");
        if (fileType) args.push("--type", fileType);
        if (glob) args.push("--glob", glob);

        if (outputMode === "files_with_matches") {
          args.push("-l");
        } else if (outputMode === "count") {
          args.push("-c");
        } else {
          args.push("-n"); // line numbers for content mode
        }

        args.push("--", shellQuote(pattern), searchPath);

        if (headLimit > 0) {
          command = args.join(" ") + ` | head -${headLimit}`;
        } else {
          command = args.join(" ");
        }
      } else {
        // Fallback: system grep
        const args = ["grep", "-rn"];
        if (ignoreCase) args.push("-i");
        if (glob) args.push(`--include=${glob}`);
        if (outputMode === "files_with_matches") args.push("-l");
        if (outputMode === "count") args.push("-c");
        args.push("-E", shellQuote(pattern), searchPath);

        if (headLimit > 0) {
          command = args.join(" ") + ` | head -${headLimit}`;
        } else {
          command = args.join(" ");
        }
      }

      const result = await execAsync(command, { cwd: workspaceRoot, timeout: 15_000 });
      const output = result.stdout.trim();

      if (!output) return "No matches found.";

      const lines = output.split("\n");
      if (headLimit > 0 && lines.length >= headLimit) {
        return output + `\n\n[Truncated at ${headLimit} lines]`;
      }
      return output;
    } catch (err: any) {
      if (err?.exitCode === 1) return "No matches found.";
      return `Error: ${errMsg(err)}`;
    }
  },
};

// ─── glob (replaces find) ─────────────────────────────────────────────

const globTool: ToolDefinition = {
  name: "glob",
  description:
    "Find files by glob pattern. Returns matching file paths. Searches in the workspace by default.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match (e.g. '**/*.ts', 'src/**/*.md')." },
      path: { type: "string", description: "Directory to search in. Default: workspace root." },
    },
    required: ["pattern"],
  },
  isReadOnly: true,
  category: "search",
  async execute(input) {
    const pattern = input.pattern as string;
    const searchPath = input.path ? resolveFilePath(input.path as string) : workspaceRoot;

    // Use find for basic name globs, or rg --files --glob for complex patterns
    const useRg = await detectRipgrep();

    try {
      let command: string;
      if (useRg) {
        command = `rg --files --glob ${shellQuote(pattern)} ${shellQuote(searchPath)} 2>/dev/null | head -200`;
      } else {
        command = `find ${shellQuote(searchPath)} -name ${shellQuote(pattern)} -type f 2>/dev/null | head -200`;
      }

      const result = await execAsync(command, { cwd: workspaceRoot, timeout: 15_000 });
      const output = result.stdout.trim();
      if (!output) return "No files found.";
      return output;
    } catch (err) {
      return `Error: ${errMsg(err)}`;
    }
  },
};

// ─── Export ───────────────────────────────────────────────────────────

export function createShellTools(): ToolDefinition[] {
  return [bashTool, grepTool, globTool];
}
