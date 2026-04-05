import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadSkills, formatSkillsForPrompt } from "../skills.js";

describe("loadSkills", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawarts-skills-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for missing directory", () => {
    const skills = loadSkills({ bundledDir: "/nonexistent/path" });
    expect(skills).toEqual([]);
  });

  it("loads skill from SKILL.md", () => {
    const skillDir = path.join(tmpDir, "greet");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: greet",
      "description: Greet the user",
      "---",
      "Instructions for greeting.",
    ].join("\n"));

    const skills = loadSkills({ bundledDir: tmpDir });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("greet");
    expect(skills[0].description).toBe("Greet the user");
  });

  it("uses directory name when frontmatter name is missing", () => {
    const skillDir = path.join(tmpDir, "fallback_name");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "description: A skill",
      "---",
      "Body.",
    ].join("\n"));

    const skills = loadSkills({ bundledDir: tmpDir });
    expect(skills[0].name).toBe("fallback_name");
  });

  it("parses allowed-tools from frontmatter", () => {
    const skillDir = path.join(tmpDir, "restricted");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: restricted",
      "description: A restricted skill",
      "allowed-tools:",
      "  - read_file",
      "  - web_search",
      "---",
      "Body.",
    ].join("\n"));

    const skills = loadSkills({ bundledDir: tmpDir });
    expect(skills[0].allowedTools).toEqual(["read_file", "web_search"]);
  });

  it("workspace skills override bundled skills", () => {
    const bundled = path.join(tmpDir, "bundled");
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(path.join(bundled, "greet"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "greet"), { recursive: true });
    fs.writeFileSync(path.join(bundled, "greet", "SKILL.md"), "---\nname: greet\ndescription: bundled\n---\n");
    fs.writeFileSync(path.join(workspace, "greet", "SKILL.md"), "---\nname: greet\ndescription: workspace\n---\n");

    const skills = loadSkills({ bundledDir: bundled, workspaceDir: workspace });
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe("workspace");
    expect(skills[0].source).toBe("workspace");
  });

  it("sanitizes skill names with special characters", () => {
    const skillDir = path.join(tmpDir, "bad-name");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      'name: "<script>alert</script>"',
      "description: test",
      "---",
      "Body.",
    ].join("\n"));

    const skills = loadSkills({ bundledDir: tmpDir });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).not.toContain("<");
    expect(skills[0].name).not.toContain(">");
  });

  it("skips directories without SKILL.md and recurses", () => {
    // Create: tmpDir/parent/child/SKILL.md
    const nested = path.join(tmpDir, "parent", "child");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "SKILL.md"), "---\nname: nested\ndescription: deep\n---\n");

    const skills = loadSkills({ bundledDir: tmpDir });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("nested");
  });
});

describe("formatSkillsForPrompt", () => {
  it("returns empty string for no skills", () => {
    expect(formatSkillsForPrompt([])).toBe("");
  });

  it("formats skills as XML", () => {
    const output = formatSkillsForPrompt([
      { name: "greet", description: "Say hello", filePath: "/path/SKILL.md" },
    ]);
    expect(output).toContain("<available_skills>");
    expect(output).toContain("<name>greet</name>");
    expect(output).toContain("<description>Say hello</description>");
    expect(output).toContain("<location>/path/SKILL.md</location>");
    expect(output).toContain("</available_skills>");
  });

  it("escapes XML special characters in skill metadata", () => {
    const output = formatSkillsForPrompt([
      { name: "test", description: 'Contains <html> & "quotes"', filePath: "/path/SKILL.md" },
    ]);
    expect(output).toContain("&lt;html&gt;");
    expect(output).toContain("&amp;");
    expect(output).not.toContain("<html>");
  });

  it("includes optional fields when present", () => {
    const output = formatSkillsForPrompt([
      {
        name: "quiz",
        description: "Run a quiz",
        filePath: "/p/SKILL.md",
        whenToUse: "student asks for quiz",
        arguments: "topic:string",
        allowedTools: ["read_file", "bash"],
      },
    ]);
    expect(output).toContain("<when_to_use>student asks for quiz</when_to_use>");
    expect(output).toContain("<arguments>topic:string</arguments>");
    expect(output).toContain("<allowed_tools>read_file, bash</allowed_tools>");
  });
});
