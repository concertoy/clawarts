import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { ToolDefinition } from "./types.js";

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
  async execute(input) {
    const filePath = resolveFilePath(input.path as string);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
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
  async execute(input) {
    const filePath = resolveFilePath(input.path as string);
    const content = input.content as string;

    const resolvedWorkspace = path.resolve(workspaceRoot);
    if (!filePath.startsWith(resolvedWorkspace + path.sep) && filePath !== resolvedWorkspace) {
      return `Error: write_file is restricted to the workspace directory (${resolvedWorkspace}). Path "${filePath}" is outside the workspace.`;
    }

    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");
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
  async execute(input) {
    const filePath = resolveFilePath(input.path as string);
    const oldText = input.oldText as string;
    const newText = input.newText as string;

    const resolvedWorkspace = path.resolve(workspaceRoot);
    if (!filePath.startsWith(resolvedWorkspace + path.sep) && filePath !== resolvedWorkspace) {
      return `Error: edit is restricted to the workspace directory (${resolvedWorkspace}).`;
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const idx = content.indexOf(oldText);
      if (idx === -1) return `Error: oldText not found in ${filePath}`;

      // Check for multiple matches
      const secondIdx = content.indexOf(oldText, idx + 1);
      if (secondIdx !== -1) return `Error: oldText matches multiple locations in ${filePath}. Provide more context to make it unique.`;

      const updated = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
      fs.writeFileSync(filePath, updated, "utf-8");

      const lineNum = content.slice(0, idx).split("\n").length;
      return `Edited ${filePath} at line ${lineNum}`;
    } catch (err) {
      return `Error editing file: ${errMsg(err)}`;
    }
  },
};

// ─── bash ──────────────────────────────────────────────────────────────

const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Execute a shell command in the workspace directory. Returns stdout and stderr. Use timeout to limit long-running commands.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      timeout: { type: "number", description: "Timeout in milliseconds. Default: 30000 (30s)." },
    },
    required: ["command"],
  },
  async execute(input) {
    const command = input.command as string;
    const timeout = (input.timeout as number) ?? 30_000;

    try {
      const output = execSync(command, {
        cwd: workspaceRoot,
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const result = (output ?? "").trim();
      if (result.length > 100_000) {
        return result.slice(0, 100_000) + "\n\n[Truncated]";
      }
      return result || "(no output)";
    } catch (err: any) {
      // execSync throws on non-zero exit code — include stdout + stderr
      const stdout = (err.stdout as string) ?? "";
      const stderr = (err.stderr as string) ?? "";
      const exitCode = err.status ?? "unknown";
      return `Exit code: ${exitCode}\n${stdout}\n${stderr}`.trim();
    }
  },
};

// ─── grep ──────────────────────────────────────────────────────────────

const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents using a regex pattern. Searches in the workspace by default.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for." },
      path: { type: "string", description: "Directory or file to search in. Default: workspace root." },
      glob: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts')." },
      ignoreCase: { type: "boolean", description: "Case-insensitive search. Default: false." },
    },
    required: ["pattern"],
  },
  async execute(input) {
    const pattern = input.pattern as string;
    const searchPath = input.path ? resolveFilePath(input.path as string) : workspaceRoot;
    const glob = input.glob as string | undefined;
    const ignoreCase = input.ignoreCase as boolean | undefined;

    const args = ["grep", "-rn"];
    if (ignoreCase) args.push("-i");
    if (glob) args.push(`--include=${glob}`);
    args.push("-E", pattern, searchPath);

    try {
      const output = execSync(args.join(" "), {
        cwd: workspaceRoot,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const result = (output ?? "").trim();
      if (!result) return "No matches found.";
      const lines = result.split("\n");
      if (lines.length > 200) {
        return lines.slice(0, 200).join("\n") + `\n\n[Truncated: ${lines.length} total matches]`;
      }
      return result;
    } catch (err: any) {
      if (err.status === 1) return "No matches found.";
      return `Error: ${(err.stderr as string) ?? errMsg(err)}`;
    }
  },
};

// ─── find ──────────────────────────────────────────────────────────────

const findTool: ToolDefinition = {
  name: "find",
  description:
    "Find files by name pattern (glob). Searches in the workspace by default.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match file names (e.g. '*.md', 'src/**/*.ts')." },
      path: { type: "string", description: "Directory to search in. Default: workspace root." },
    },
    required: ["pattern"],
  },
  async execute(input) {
    const pattern = input.pattern as string;
    const searchPath = input.path ? resolveFilePath(input.path as string) : workspaceRoot;

    try {
      const output = execSync(`find ${JSON.stringify(searchPath)} -name ${JSON.stringify(pattern)} -type f 2>/dev/null | head -200`, {
        cwd: workspaceRoot,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
      });
      const result = (output ?? "").trim();
      if (!result) return "No files found.";
      return result;
    } catch (err: any) {
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
  async execute(input) {
    const dirPath = input.path ? resolveFilePath(input.path as string) : workspaceRoot;

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      if (entries.length === 0) return "(empty directory)";

      const lines = entries
        .sort((a, b) => {
          // Directories first, then files
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

// Simple in-memory cache: query -> { results, expiresAt }
const ddgCache = new Map<string, { results: string; expiresAt: number }>();
const DDG_CACHE_TTL = 60 * 60 * 1000; // 60 minutes

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

      // Detect bot challenge
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

  // Match result links: <a class="result__a" href="...">title</a>
  const linkRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi;
  // Match snippets: <a class="result__snippet" ...>snippet</a>
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

  // Collect all snippets
  const snippets: { text: string; idx: number }[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push({
      text: stripHtml(decodeHtmlEntities(match[1])),
      idx: match.index,
    });
  }

  // Pair each link with the nearest following snippet
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
  // Protocol-relative
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

// ─── web_fetch (Readability-based, ported from OpenClaw) ──────────────

const WEB_FETCH_TIMEOUT = 30_000;
const WEB_FETCH_MAX_CHARS = 50_000;
const WEB_FETCH_MAX_HTML = 1_000_000;
const WEB_FETCH_MAX_RESPONSE_BYTES = 2_000_000;

// Cache: url:mode -> { result, expiresAt }
const fetchCache = new Map<string, { result: string; expiresAt: number }>();
const FETCH_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description:
    "Fetch and extract readable content from a URL (HTML → markdown/text). Uses Mozilla Readability for intelligent content extraction. Works with articles, docs, and server-rendered pages. For JSON APIs, returns raw JSON.",
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
        // JSON: pretty-print
        try {
          result = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          result = body;
        }
      } else if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
        // HTML: Readability → htmlToMarkdown fallback → basic strip
        result = extractHtmlContent(body, url, extractMode);
      } else {
        // Plain text or other
        result = body;
      }

      // Truncate
      if (result.length > maxChars) {
        result = result.slice(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`;
      }

      if (!result.trim()) result = "(empty page — this site likely renders content via JavaScript. Try searching for a JSON/REST API endpoint for this site instead, e.g. web_search for '<site name> API' or '<site name> open data'.)";

      fetchCache.set(cacheKey, { result, expiresAt: Date.now() + FETCH_CACHE_TTL });
      return result;
    } catch (err) {
      return `Fetch failed: ${errMsg(err)}`;
    }
  },
};

/**
 * Extract readable content from HTML using Readability (ported from OpenClaw's web-fetch-utils.ts).
 * Falls back to basic HTML-to-markdown conversion if Readability fails.
 */
function extractHtmlContent(html: string, url: string, mode: string): string {
  // Sanitize: remove hidden elements, scripts, styles
  const sanitized = sanitizeHtml(html);

  // Try Readability first (like OpenClaw)
  if (sanitized.length <= WEB_FETCH_MAX_HTML) {
    try {
      const { document } = parseHTML(sanitized);
      // Set base URI for relative link resolution
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

  // Fallback: basic HTML → markdown conversion (from OpenClaw's extractBasicHtmlContent)
  const md = htmlToMarkdown(sanitized);
  const result = mode === "text" ? markdownToText(md) : md;
  return normalizeWhitespace(result);
}

/**
 * Sanitize HTML: remove scripts, styles, hidden elements, comments.
 * Ported from OpenClaw's web-fetch-visibility.ts.
 */
function sanitizeHtml(html: string): string {
  return html
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, "")
    // Remove script, style, noscript, svg, canvas, iframe, template blocks
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<canvas[\s\S]*?<\/canvas>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<template[\s\S]*?<\/template>/gi, "")
    // Remove hidden inputs
    .replace(/<input[^>]*type=["']hidden["'][^>]*>/gi, "")
    // Remove elements with aria-hidden="true"
    .replace(/<[^>]+aria-hidden=["']true["'][^>]*>[\s\S]*?<\/[^>]+>/gi, "")
    // Remove elements with display:none or visibility:hidden in inline styles
    .replace(/<[^>]+style="[^"]*display\s*:\s*none[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, "")
    .replace(/<[^>]+style="[^"]*visibility\s*:\s*hidden[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, "")
    // Remove meta tags
    .replace(/<meta[^>]*>/gi, "");
}

/**
 * Convert HTML to markdown. Ported from OpenClaw's htmlToMarkdown().
 */
function htmlToMarkdown(html: string): string {
  let title = "";
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = decodeHtmlEntities(stripHtml(titleMatch[1]));

  let md = html
    // Remove leftover script/style
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // Convert links
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const text = stripHtml(label).trim();
      return text ? `[${text}](${href})` : "";
    })
    // Convert headings
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
      const prefix = "#".repeat(Number(level));
      return `\n${prefix} ${stripHtml(content).trim()}\n`;
    })
    // Convert list items
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => `\n- ${stripHtml(content).trim()}`)
    // Block element closings → newlines
    .replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, "\n")
    // <br> and <hr>
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    // Strip all remaining tags
    .replace(/<[^>]+>/g, " ")
    // Decode entities
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

/**
 * Strip markdown formatting to plain text. Ported from OpenClaw's markdownToText().
 */
function markdownToText(md: string): string {
  return md
    // Remove images
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    // Convert links to just text
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    // Remove heading markers
    .replace(/^#{1,6}\s+/gm, "")
    // Remove list bullets
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "");
}

/** Collapse whitespace: remove \\r, collapse spaces, reduce excessive newlines. */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove invisible Unicode characters (zero-width, direction markers). */
function stripInvisibleUnicode(text: string): string {
  return text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/g, "");
}

// ─── Registry ──────────────────────────────────────────────────────────

export function createToolRegistry(workspaceDir: string): ToolDefinition[] {
  workspaceRoot = workspaceDir;
  return [readFileTool, writeFileTool, editTool, bashTool, grepTool, findTool, lsTool, webSearchTool, webFetchTool];
}

export async function executeTool(
  tools: ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `Unknown tool: ${name}`;
  try {
    return await tool.execute(input);
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
