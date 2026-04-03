import fs from "node:fs";
import path from "node:path";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { ToolDefinition } from "./types.js";
import { execAsync } from "./utils/exec-async.js";
import type { CronService } from "./cron/service.js";
import { createCronTool } from "./cron/tool.js";

let workspaceRoot = "";

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
      await fs.promises.writeFile(filePath, content, "utf-8");
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
      await fs.promises.writeFile(filePath, updated, "utf-8");

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
        const { oldText, newText } = edits[i];
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

      await fs.promises.writeFile(filePath, content, "utf-8");
      return `Multi-edit ${filePath}:\n${results.join("\n")}`;
    } catch (err) {
      return `Error in multi_edit: ${errMsg(err)}`;
    }
  },
};

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

        args.push("--", JSON.stringify(pattern).slice(1, -1), searchPath);

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
        args.push("-E", JSON.stringify(pattern), searchPath);

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
        command = `rg --files --glob ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)} 2>/dev/null | head -200`;
      } else {
        command = `find ${JSON.stringify(searchPath)} -name ${JSON.stringify(pattern)} -type f 2>/dev/null | head -200`;
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

// ─── web_search (DuckDuckGo) ──────────────────────────────────────────

const DDG_URL = "https://html.duckduckgo.com/html";
const DDG_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DDG_TIMEOUT = 20_000;

const ddgCache = new Map<string, { results: string; expiresAt: number }>();
const DDG_CACHE_TTL = 60 * 60 * 1000;

const webSearchTool: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web using DuckDuckGo. Returns titles, URLs, and snippets. No API key required.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      count: { type: "number", description: "Number of results (1-10). Default: 5." },
    },
    required: ["query"],
  },
  isReadOnly: true,
  category: "web",
  async execute(input) {
    const query = input.query as string;
    const count = Math.min(Math.max((input.count as number) ?? 5, 1), 10);

    const cacheKey = `${query}:${count}`;
    const cached = ddgCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.results;

    try {
      const params = new URLSearchParams({ q: query, kp: "-1" });
      const url = `${DDG_URL}?${params}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DDG_TIMEOUT);

      const resp = await fetch(url, {
        headers: { "User-Agent": DDG_USER_AGENT },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return `DuckDuckGo search error (${resp.status}): ${text.slice(0, 500)}`;
      }

      const html = await resp.text();

      if (
        /g-recaptcha|are you a human|id="challenge-form"|name="challenge"/i.test(html) &&
        !/result__a/i.test(html)
      ) {
        return "DuckDuckGo returned a bot-detection challenge. Try again later.";
      }

      const results = parseDdgResults(html, count);
      if (results.length === 0) return `No results found for: ${query}`;

      const formatted = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");

      const output = `Search results for: ${query}\n\n${formatted}`;

      ddgCache.set(cacheKey, { results: output, expiresAt: Date.now() + DDG_CACHE_TTL });
      return output;
    } catch (err) {
      return `DuckDuckGo search failed: ${errMsg(err)}`;
    }
  },
};

interface DdgResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDdgResults(html: string, count: number): DdgResult[] {
  const results: DdgResult[] = [];

  const linkRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/gi;

  const links: { title: string; url: string; endIdx: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const attrs = match[1];
    const rawTitle = match[2];
    const hrefMatch = attrs.match(/\bhref="([^"]*)"/i);
    if (!hrefMatch) continue;

    const url = decodeDdgUrl(decodeHtmlEntities(hrefMatch[1]));
    if (!url || url.startsWith("javascript:")) continue;

    links.push({
      title: stripHtml(decodeHtmlEntities(rawTitle)),
      url,
      endIdx: linkRegex.lastIndex,
    });
  }

  const snippets: { text: string; idx: number }[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push({
      text: stripHtml(decodeHtmlEntities(match[1])),
      idx: match.index,
    });
  }

  for (const link of links) {
    const snippet = snippets.find((s) => s.idx > link.endIdx);
    results.push({
      title: link.title,
      url: link.url,
      snippet: snippet?.text ?? "",
    });
    if (results.length >= count) break;
  }

  return results;
}

function decodeDdgUrl(raw: string): string {
  try {
    const parsed = new URL(raw, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
  } catch {
    // not a redirect URL
  }
  if (raw.startsWith("//")) return `https:${raw}`;
  return raw;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;|&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "--")
    .replace(/&hellip;/g, "...")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ─── web_fetch (Readability-based) ────────────────────────────────────

const WEB_FETCH_TIMEOUT = 30_000;
const WEB_FETCH_MAX_CHARS = 50_000;
const WEB_FETCH_MAX_HTML = 1_000_000;
const WEB_FETCH_MAX_RESPONSE_BYTES = 2_000_000;

const fetchCache = new Map<string, { result: string; expiresAt: number }>();
const FETCH_CACHE_TTL = 15 * 60 * 1000;

const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description:
    "Fetch and extract readable content from a URL (HTML -> markdown/text). Uses Mozilla Readability for intelligent content extraction.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
      extractMode: {
        type: "string",
        description: 'Extraction mode: "markdown" (default) or "text".',
        enum: ["markdown", "text"],
      },
      maxChars: {
        type: "number",
        description: "Maximum characters to return. Default: 50000.",
      },
    },
    required: ["url"],
  },
  isReadOnly: true,
  category: "web",
  async execute(input) {
    const url = input.url as string;
    const extractMode = (input.extractMode as string) ?? "markdown";
    const maxChars = Math.max((input.maxChars as number) ?? WEB_FETCH_MAX_CHARS, 100);

    try {
      new URL(url);
    } catch {
      return `Error: Invalid URL — must be http or https: ${url}`;
    }

    const cacheKey = `${url}:${extractMode}:${maxChars}`.toLowerCase();
    const cached = fetchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT);

      const resp = await fetch(url, {
        headers: {
          "User-Agent": DDG_USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);

      if (!resp.ok) {
        return `Fetch error (${resp.status}): ${resp.statusText}`;
      }

      const contentType = resp.headers.get("content-type") ?? "";
      const rawBody = await resp.text();
      const body = rawBody.length > WEB_FETCH_MAX_RESPONSE_BYTES
        ? rawBody.slice(0, WEB_FETCH_MAX_RESPONSE_BYTES)
        : rawBody;

      let result: string;

      if (contentType.includes("application/json")) {
        try {
          result = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          result = body;
        }
      } else if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
        result = extractHtmlContent(body, url, extractMode);
      } else {
        result = body;
      }

      if (result.length > maxChars) {
        result = result.slice(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`;
      }

      if (!result.trim()) result = "(empty page — this site likely renders content via JavaScript.)";

      fetchCache.set(cacheKey, { result, expiresAt: Date.now() + FETCH_CACHE_TTL });
      return result;
    } catch (err) {
      return `Fetch failed: ${errMsg(err)}`;
    }
  },
};

function extractHtmlContent(html: string, url: string, mode: string): string {
  const sanitized = sanitizeHtml(html);

  if (sanitized.length <= WEB_FETCH_MAX_HTML) {
    try {
      const { document } = parseHTML(sanitized);
      try {
        (document as any).baseURI = url;
      } catch { /* linkedom may not support */ }

      const reader = new Readability(document as any, { charThreshold: 0 });
      const parsed = reader.parse();
      if (parsed && parsed.content) {
        const title = parsed.title ? `# ${parsed.title}\n\n` : "";
        const content = mode === "text"
          ? markdownToText(htmlToMarkdown(parsed.content))
          : htmlToMarkdown(parsed.content);
        const result = title + normalizeWhitespace(content);
        if (result.trim().length > 50) return result;
      }
    } catch {
      // Readability failed — fall through
    }
  }

  const md = htmlToMarkdown(sanitized);
  const result = mode === "text" ? markdownToText(md) : md;
  return normalizeWhitespace(result);
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<canvas[\s\S]*?<\/canvas>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<template[\s\S]*?<\/template>/gi, "")
    .replace(/<input[^>]*type=["']hidden["'][^>]*>/gi, "")
    .replace(/<[^>]+aria-hidden=["']true["'][^>]*>[\s\S]*?<\/[^>]+>/gi, "")
    .replace(/<[^>]+style="[^"]*display\s*:\s*none[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, "")
    .replace(/<[^>]+style="[^"]*visibility\s*:\s*hidden[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, "")
    .replace(/<meta[^>]*>/gi, "");
}

function htmlToMarkdown(html: string): string {
  let title = "";
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = decodeHtmlEntities(stripHtml(titleMatch[1]));

  let md = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const text = stripHtml(label).trim();
      return text ? `[${text}](${href})` : "";
    })
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
      const prefix = "#".repeat(Number(level));
      return `\n${prefix} ${stripHtml(content).trim()}\n`;
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => `\n- ${stripHtml(content).trim()}`)
    .replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

  if (title) md = `# ${title}\n\n${md}`;
  return md;
}

function markdownToText(md: string): string {
  return md
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "");
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Registry ──────────────────────────────────────────────────────────

export function createToolRegistry(
  workspaceDir: string,
  opts?: { cronService?: CronService; agentId?: string },
): ToolDefinition[] {
  workspaceRoot = workspaceDir;
  const tools: ToolDefinition[] = [readFileTool, writeFileTool, editTool, multiEditTool, bashTool, grepTool, globTool, lsTool, webSearchTool, webFetchTool];
  if (opts?.cronService && opts?.agentId) {
    tools.push(createCronTool(opts.cronService, opts.agentId));
  }
  return tools;
}

export async function executeTool(
  tools: ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
  context?: import("./types.js").ToolUseContext,
): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `Unknown tool: ${name}`;
  try {
    return await tool.execute(input, context);
  } catch (err) {
    return `Tool execution error: ${errMsg(err)}`;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function resolveFilePath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.resolve(path.join(process.env.HOME ?? "", filePath.slice(2)));
  }
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  return path.resolve(workspaceRoot, filePath);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
