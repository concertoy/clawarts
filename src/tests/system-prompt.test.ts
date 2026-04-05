import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../system-prompt.js";

describe("buildSystemPrompt", () => {
  const baseParams = {
    identity: "You are a helpful tutor.",
    skills: [],
    workspaceFiles: [],
  };

  it("includes identity in output", () => {
    const prompt = buildSystemPrompt(baseParams);
    expect(prompt).toContain("You are a helpful tutor.");
  });

  it("includes tool usage guidance", () => {
    const prompt = buildSystemPrompt(baseParams);
    expect(prompt).toContain("Tool call style");
    expect(prompt).toContain("Tool usage");
  });

  it("injects hints-only constraint", () => {
    const prompt = buildSystemPrompt({ ...baseParams, helpLevel: "hints" });
    expect(prompt).toContain("HINTS-ONLY mode");
    expect(prompt).toContain("MANDATORY");
  });

  it("injects guided constraint", () => {
    const prompt = buildSystemPrompt({ ...baseParams, helpLevel: "guided" });
    expect(prompt).toContain("GUIDED mode");
    expect(prompt).toContain("do not provide complete solutions");
  });

  it("omits constraint for full help level", () => {
    const prompt = buildSystemPrompt({ ...baseParams, helpLevel: "full" });
    expect(prompt).not.toContain("Academic integrity");
  });

  it("omits constraint when helpLevel is undefined", () => {
    const prompt = buildSystemPrompt(baseParams);
    expect(prompt).not.toContain("Academic integrity");
  });

  it("includes workspace files as project context", () => {
    const prompt = buildSystemPrompt({
      ...baseParams,
      workspaceFiles: [
        { name: "SOUL.md", content: "Be a wise owl." },
        { name: "COURSE.md", content: "CS101 syllabus" },
      ],
    });
    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("## SOUL.md");
    expect(prompt).toContain("Be a wise owl.");
    expect(prompt).toContain("## COURSE.md");
    expect(prompt).toContain("CS101 syllabus");
  });

  it("mentions SOUL.md persona guidance when present", () => {
    const prompt = buildSystemPrompt({
      ...baseParams,
      workspaceFiles: [{ name: "SOUL.md", content: "persona" }],
    });
    expect(prompt).toContain("embody its persona");
  });

  it("omits persona guidance when SOUL.md is absent", () => {
    const prompt = buildSystemPrompt({
      ...baseParams,
      workspaceFiles: [{ name: "TOOLS.md", content: "tools" }],
    });
    expect(prompt).not.toContain("embody its persona");
  });

  it("lists available tools", () => {
    const prompt = buildSystemPrompt({
      ...baseParams,
      tools: [
        { name: "read_file", description: "Read a file.", isReadOnly: true, category: "filesystem", parameters: { type: "object", properties: {} }, execute: async () => "" },
        { name: "bash", description: "Run a shell command.", isReadOnly: false, category: "shell", parameters: { type: "object", properties: {} }, execute: async () => "" },
      ],
    });
    expect(prompt).toContain("## Available tools");
    expect(prompt).toContain("`read_file` [filesystem]");
    expect(prompt).toContain("`bash` [shell]");
  });

  it("does not truncate tool descriptions at version-like periods", () => {
    const prompt = buildSystemPrompt({
      ...baseParams,
      tools: [
        { name: "web_fetch", description: "Fetch a URL (max 5.0 MB). Returns markdown content.", isReadOnly: true, parameters: { type: "object", properties: {} }, execute: async () => "" },
      ],
    });
    // Should split at ". R" (sentence boundary), not at "5.0"
    expect(prompt).toContain("Fetch a URL (max 5.0 MB).");
  });

  it("includes skills section when skills provided", () => {
    const prompt = buildSystemPrompt({
      ...baseParams,
      skills: [
        {
          name: "homework",
          description: "Create homework",
          filePath: "/path/to/SKILL.md",
        },
      ],
    });
    expect(prompt).toContain("Skills (mandatory)");
    expect(prompt).toContain("homework");
  });
});
