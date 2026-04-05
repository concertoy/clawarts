import { describe, it, expect } from "vitest";
import { filterToolsForAgent } from "../tool-filter.js";
import type { AgentConfig, ToolCategory, ToolDefinition } from "../types.js";

function makeTool(name: string, category?: ToolCategory): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => "ok",
    category,
  };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test",
    provider: "anthropic-claude",
    model: "claude-sonnet-4-20250514",
    maxTokens: 8192,
    systemPrompt: "",
    skillsDirs: [],
    skillSources: { bundledDir: "", userGlobalDir: "", agentDir: "", workspaceDir: "" },
    sessionTtlMinutes: 120,
    workspaceDir: "/tmp",
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    ...overrides,
  };
}

describe("filterToolsForAgent", () => {
  const tools = [
    makeTool("read_file", "filesystem"),
    makeTool("write_file", "filesystem"),
    makeTool("bash", "shell"),
    makeTool("web_search", "web"),
    makeTool("web_fetch", "web"),
  ];

  it("returns all tools with no filters", () => {
    const result = filterToolsForAgent(tools, makeConfig());
    expect(result).toHaveLength(5);
  });

  it("filters by allowedTools (exact name)", () => {
    const result = filterToolsForAgent(tools, makeConfig({ allowedTools: ["read_file", "bash"] }));
    expect(result.map((t) => t.name)).toEqual(["read_file", "bash"]);
  });

  it("filters by allowedTools (category)", () => {
    const result = filterToolsForAgent(tools, makeConfig({ allowedTools: ["category:web"] }));
    expect(result.map((t) => t.name)).toEqual(["web_search", "web_fetch"]);
  });

  it("filters by disallowedTools", () => {
    const result = filterToolsForAgent(tools, makeConfig({ disallowedTools: ["bash"] }));
    expect(result.map((t) => t.name)).toEqual(["read_file", "write_file", "web_search", "web_fetch"]);
  });

  it("filters by disallowedTools (category)", () => {
    const result = filterToolsForAgent(tools, makeConfig({ disallowedTools: ["category:filesystem"] }));
    expect(result.map((t) => t.name)).toEqual(["bash", "web_search", "web_fetch"]);
  });

  it("wildcard * matches all tools", () => {
    const result = filterToolsForAgent(tools, makeConfig({ allowedTools: ["*"] }));
    expect(result).toHaveLength(5);
  });

  it("wildcard prefix matches tools", () => {
    const result = filterToolsForAgent(tools, makeConfig({ allowedTools: ["web_*"] }));
    expect(result.map((t) => t.name)).toEqual(["web_search", "web_fetch"]);
  });

  it("respects isEnabled gate", () => {
    const gatedTools = [
      { ...makeTool("enabled"), isEnabled: () => true },
      { ...makeTool("disabled"), isEnabled: () => false },
    ];
    const result = filterToolsForAgent(gatedTools, makeConfig());
    expect(result.map((t) => t.name)).toEqual(["enabled"]);
  });
});
