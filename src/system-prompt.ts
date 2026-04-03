import type { Skill, ToolDefinition, WorkspaceFile } from "./types.js";
import { formatSkillsForPrompt } from "./skills.js";

export function buildSystemPrompt(params: {
  identity: string;
  skills: Skill[];
  workspaceFiles: WorkspaceFile[];
  tools?: ToolDefinition[];
}): string {
  const sections: string[] = [];

  // Identity
  sections.push(params.identity);

  // Skills section (mirrors OpenClaw's buildSkillsSection)
  const skillsXml = formatSkillsForPrompt(params.skills);
  if (skillsXml) {
    sections.push(
      [
        "## Skills (mandatory)",
        'Before replying: scan <available_skills> <description> entries.',
        "- If exactly one skill clearly applies: read its SKILL.md at <location> with `read_file`, then follow it.",
        "- If multiple could apply: choose the most specific one, then read/follow it.",
        "- If none clearly apply: do not read any SKILL.md.",
        "Constraints: never read more than one skill up front; only read after selecting.",
        skillsXml,
      ].join("\n"),
    );
  }

  // Project Context — workspace files (SOUL.md, IDENTITY.md, AGENTS.md, etc.)
  if (params.workspaceFiles.length > 0) {
    const lines: string[] = ["# Project Context", ""];

    const hasSoul = params.workspaceFiles.some((f) => f.name.toLowerCase() === "soul.md");
    if (hasSoul) {
      lines.push(
        "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
        "",
      );
    }

    for (const file of params.workspaceFiles) {
      lines.push(`## ${file.name}`, "", file.content, "");
    }

    sections.push(lines.join("\n"));
  }

  // Tool call style + usage guidance (ported from OpenClaw's system-prompt.ts)
  sections.push(
    [
      "## Tool call style",
      "",
      "Do not narrate routine tool calls — just call the tool and present the answer.",
      "Narrate only when it genuinely helps: multi-step work, complex problems, sensitive actions, or when the user explicitly asks.",
      "Keep narration brief and value-dense; avoid repeating obvious steps.",
      "Never expose internal tool mechanics, error details, or metadata to the user. Rewrite tool outputs into natural, conversational language.",
      "Never say things like \"I searched and found...\" or \"my tools couldn't fetch...\" or \"the API returned...\" — just give the answer.",
      "If a tool fails silently, retry with a different approach. Do not explain the failure to the user unless all approaches are exhausted.",
      "",
      "## Tool usage",
      "",
      "You have access to tools. Use them proactively to answer questions — do not just list URLs or say you cannot help.",
      "",
      "### web_search + web_fetch strategy",
      "When the user asks a factual question (weather, news, data, etc.):",
      "1. Use `web_search` to find relevant pages.",
      "2. Use `web_fetch` on the most promising URL to get actual content.",
      "3. If `web_fetch` returns empty or template-only content (common with JavaScript-rendered sites), search for a **JSON/REST API** instead (e.g. search for `<site> API` or `<topic> open data API`).",
      "4. Fetch the API endpoint with `web_fetch` — JSON responses are returned as structured data.",
      "5. Extract and present the answer from the fetched content. Never respond with just a list of URLs.",
      "",
      "Many government and public services provide open data APIs that return JSON — prefer these over scraping HTML.",
      "",
      "### cron (reminders & scheduled alerts)",
      "When the user asks to be reminded about something or to schedule a recurring notification:",
      '1. Use the `cron` tool with action="add" to create a scheduled reminder.',
      "2. You MUST provide the `channelId` — use the Slack channel ID from the current conversation context.",
      '3. For recurring reminders, use scheduleKind="every" with everyMs in milliseconds (60000=1min, 3600000=1hr, 86400000=1day).',
      '4. For one-shot reminders, use scheduleKind="at" with atMs as epoch milliseconds. Compute from the current date.',
      '5. Use action="list" to show existing reminders, action="remove" to delete one.',
    ].join("\n"),
  );

  // Available tools section — ported from claude-code's tool documentation injection
  if (params.tools && params.tools.length > 0) {
    const toolLines = params.tools.map((t) => {
      const cat = t.category ? ` [${t.category}]` : "";
      return `- \`${t.name}\`${cat}: ${t.description.split(".")[0]}.`;
    });
    sections.push(
      ["## Available tools", "", ...toolLines].join("\n"),
    );
  }

  // Note: Current date/time is injected per-turn in agent.ts (not here)
  // to avoid stale timestamps on long-running processes.

  return sections.join("\n\n");
}
