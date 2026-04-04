import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { ToolDefinition } from "../types.js";
import { BoundedMap } from "../utils/bounded-map.js";
import { errMsg } from "../utils/errors.js";

// ─── web_search (DuckDuckGo) ──────────────────────────────────────────

const DDG_URL = "https://html.duckduckgo.com/html";
const DDG_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DDG_TIMEOUT = 20_000;

const ddgCache = new BoundedMap<string, { results: string; expiresAt: number }>(100);
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

    const cacheKey = `${query.trim().toLowerCase()}:${count}`;
    const cached = ddgCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.results;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DDG_TIMEOUT);
    try {
      const params = new URLSearchParams({ q: query, kp: "-1" });
      const url = `${DDG_URL}?${params}`;

      const resp = await fetch(url, {
        headers: { "User-Agent": DDG_USER_AGENT },
        signal: controller.signal,
      });

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
    } finally {
      clearTimeout(timer);
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
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
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

const fetchCache = new BoundedMap<string, { result: string; expiresAt: number }>(100);
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

    const rawKey = `${url}:${extractMode}:${maxChars}`.toLowerCase();
    const cacheKey = rawKey.length > 200 ? createHash("sha256").update(rawKey).digest("hex") : rawKey;
    const cached = fetchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT);
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": DDG_USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      if (!resp.ok) {
        return `Fetch error (${resp.status}): ${resp.statusText}`;
      }

      // Reject obviously huge responses before reading body into memory
      const contentLength = parseInt(resp.headers.get("content-length") ?? "", 10);
      if (contentLength > WEB_FETCH_MAX_RESPONSE_BYTES) {
        return `Error: response too large (${Math.round(contentLength / 1024)}KB, limit ${Math.round(WEB_FETCH_MAX_RESPONSE_BYTES / 1024)}KB)`;
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
    } finally {
      clearTimeout(timer);
    }
  },
};

function extractHtmlContent(html: string, url: string, mode: string): string {
  const sanitized = sanitizeHtml(html);

  if (sanitized.length <= WEB_FETCH_MAX_HTML) {
    try {
      const { document } = parseHTML(sanitized);
      // Set base URL for relative link resolution — linkedom doesn't support
      // direct baseURI assignment, so insert a <base> element instead.
      try {
        const base = document.createElement("base");
        base.setAttribute("href", url);
        const head = document.querySelector("head");
        if (head) head.insertBefore(base, head.firstChild);
      } catch { /* best-effort */ }

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
    } catch (err) {
      console.warn(`[web-tools] Readability failed for ${url}:`, errMsg(err));
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
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
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

// ─── Export ───────────────────────────────────────────────────────────

export function createWebTools(): ToolDefinition[] {
  return [webSearchTool, webFetchTool];
}
