import fs from "node:fs";
import path from "node:path";
import type { WizardPrompter } from "../prompter.js";
import { readConfig, findAgent, resolveWorkspaceDir } from "../config-io.js";
import { buildSkillSources } from "../../config.js";
import { loadSkills } from "../../skills.js";
import { clawHome } from "../../utils/paths.js";

/** Quote a YAML value if it contains special characters (colons, quotes, etc.). */
function yamlQuote(value: string): string {
  if (/[:#\[\]{}|>&*!?,]/.test(value) || value.startsWith("'") || value.startsWith('"')) {
    return JSON.stringify(value);
  }
  return value;
}

// ─── skill add ───────────────────────────────────────────────────────

export async function skillAddCommand(prompter: WizardPrompter, agentId: string): Promise<void> {
  const config = readConfig();
  const agent = findAgent(config, agentId);
  if (!agent) {
    console.log(`Agent "${agentId}" not found. Run \`clawarts agent list\` to see configured agents.`);
    return;
  }

  const workspaceDir = resolveWorkspaceDir(agent, config);
  const skillsDir = path.join(workspaceDir, "skills");

  // Prompt for skill metadata
  const name = await prompter.text({
    message: "Skill name:",
    placeholder: "e.g. code-review, quiz",
    validate: (v) => {
      if (!v) return "Skill name is required";
      if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) return "Use lowercase letters, numbers, and hyphens";
      if (fs.existsSync(path.join(skillsDir, v, "SKILL.md"))) return `Skill "${v}" already exists`;
      return undefined;
    },
  });

  const description = await prompter.text({
    message: "Description:",
    placeholder: "What this skill does",
    validate: (v) => (v ? undefined : "Description is required"),
  });

  const whenToUse = await prompter.text({
    message: "When to use (optional):",
    placeholder: "e.g. When the user asks about code reviews",
  });

  const allowedToolsStr = await prompter.text({
    message: "Allowed tools (optional, comma-separated):",
    placeholder: "e.g. read_file, web_search",
  });

  // Build frontmatter
  const frontmatter: string[] = ["---"];
  frontmatter.push(`name: ${yamlQuote(name)}`);
  frontmatter.push(`description: ${yamlQuote(description)}`);
  if (whenToUse) frontmatter.push(`when_to_use: ${yamlQuote(whenToUse)}`);
  if (allowedToolsStr) {
    const tools = allowedToolsStr.split(",").map((s) => s.trim()).filter(Boolean);
    if (tools.length > 0) {
      frontmatter.push(`allowed-tools:`);
      for (const t of tools) frontmatter.push(`  - ${t}`);
    }
  }
  frontmatter.push("---");

  const body = [
    "",
    `# ${name}`,
    "",
    "<!-- Add skill instructions here. The agent will read this file when the skill is selected. -->",
    "",
  ].join("\n");

  // Write SKILL.md
  const skillDir = path.join(skillsDir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), frontmatter.join("\n") + body + "\n", "utf-8");

  await prompter.note(
    `Location: ${path.join(skillDir, "SKILL.md")}`,
    `Skill "${name}" created`,
  );
}

// ─── skill list ──────────────────────────────────────────────────────

export function skillListCommand(agentId?: string): void {
  const config = readConfig();

  if (agentId) {
    const agent = findAgent(config, agentId);
    if (!agent) {
      console.log(`Agent "${agentId}" not found.`);
      return;
    }
    listSkillsForAgent(agent.id, resolveWorkspaceDir(agent, config));
  } else {
    // List skills for all agents
    if (config.agents.length === 0) {
      console.log("No agents configured.");
      return;
    }
    for (const agent of config.agents) {
      console.log(`\n  [${agent.id}]`);
      listSkillsForAgent(agent.id, resolveWorkspaceDir(agent, config));
    }
  }
}

function listSkillsForAgent(agentId: string, workspaceDir: string): void {
  const agentBase = clawHome("agents", agentId);
  const sources = buildSkillSources(agentBase, workspaceDir);

  const skills = loadSkills({
    ...sources,
    legacyDirs: [path.join(workspaceDir, "skills")],
  });

  if (skills.length === 0) {
    console.log("  (no skills)");
    return;
  }

  for (const s of skills) {
    const source = s.source ? ` [${s.source}]` : "";
    console.log(`  ${s.name}${source}`);
    console.log(`    ${s.description || "(no description)"}`);
  }
}

// ─── skill remove ────────────────────────────────────────────────────

export async function skillRemoveCommand(
  prompter: WizardPrompter,
  agentId: string,
  skillName: string,
): Promise<void> {
  const config = readConfig();
  const agent = findAgent(config, agentId);
  if (!agent) {
    console.log(`Agent "${agentId}" not found.`);
    return;
  }

  const workspaceDir = resolveWorkspaceDir(agent, config);
  const agentBase = clawHome("agents", agentId);
  const sources = buildSkillSources(agentBase, workspaceDir);

  const skills = loadSkills({
    ...sources,
    legacyDirs: [path.join(workspaceDir, "skills")],
  });

  const skill = skills.find((s) => s.name === skillName);
  if (!skill) {
    console.log(`Skill "${skillName}" not found for agent "${agentId}".`);
    return;
  }

  if (skill.source !== "workspace" && skill.source !== "agent") {
    console.log(`Cannot remove ${skill.source ?? "bundled"} skill "${skillName}". Only workspace and agent-level skills can be removed.`);
    return;
  }

  const confirmed = await prompter.confirm({
    message: `Remove skill "${skillName}" at ${skill.filePath}?`,
    initialValue: false,
  });

  if (!confirmed) {
    console.log("Cancelled.");
    return;
  }

  // Remove the skill directory (parent of SKILL.md)
  const skillDir = path.dirname(skill.filePath);
  fs.rmSync(skillDir, { recursive: true, force: true });
  console.log(`Skill "${skillName}" removed.`);
}
