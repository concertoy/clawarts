#!/usr/bin/env node
import { Command } from "commander";
import { createClackPrompter, WizardCancelledError } from "./prompter.js";
import { setupWizardCommand } from "./commands/setup.js";
import { agentAddCommand, agentListCommand, agentRemoveCommand } from "./commands/agent.js";
import { skillAddCommand, skillListCommand, skillRemoveCommand } from "./commands/skill.js";
import { getVersion } from "../utils/version.js";

const program = new Command()
  .name("clawarts")
  .description("Configure and manage clawarts Slack agents")
  .version(getVersion());

// ─── clawarts setup ──────────────────────────────────────────────────

program
  .command("setup")
  .description("Full interactive setup wizard")
  .action(async () => {
    const prompter = createClackPrompter();
    await setupWizardCommand(prompter);
  });

// ─── clawarts agent ──────────────────────────────────────────────────

const agent = program.command("agent").description("Manage agents");

agent
  .command("add")
  .description("Add a new agent interactively")
  .action(async () => {
    const prompter = createClackPrompter();
    await agentAddCommand(prompter);
  });

agent
  .command("list")
  .description("List configured agents")
  .action(() => {
    agentListCommand();
  });

agent
  .command("remove")
  .argument("<id>", "Agent ID to remove")
  .description("Remove an agent")
  .action(async (id: string) => {
    const prompter = createClackPrompter();
    await agentRemoveCommand(prompter, id);
  });

// ─── clawarts skill ─────────────────────────────────────────────────

const skill = program.command("skill").description("Manage agent skills");

skill
  .command("add")
  .argument("<agent-id>", "Agent ID")
  .description("Create a new skill for an agent")
  .action(async (agentId: string) => {
    const prompter = createClackPrompter();
    await skillAddCommand(prompter, agentId);
  });

skill
  .command("list")
  .argument("[agent-id]", "Agent ID (optional, lists all if omitted)")
  .description("List skills")
  .action((agentId?: string) => {
    skillListCommand(agentId);
  });

skill
  .command("remove")
  .argument("<agent-id>", "Agent ID")
  .argument("<skill-name>", "Skill name to remove")
  .description("Remove a skill")
  .action(async (agentId: string, skillName: string) => {
    const prompter = createClackPrompter();
    await skillRemoveCommand(prompter, agentId, skillName);
  });

// ─── clawarts start ─────────────────────────────────────────────

program
  .command("start", { isDefault: true })
  .description("Start the bot server")
  .action(async () => {
    const { main } = await import("../index.js");
    await main();
  });

// ─── clawarts check ─────────────────────────────────────────────

program
  .command("check")
  .description("Validate config.json and environment variables without starting the bot")
  .action(async () => {
    const { loadAllAgentConfigs } = await import("../config.js");
    const { loadSkills } = await import("../skills.js");
    const { loadWorkspaceFiles } = await import("../workspace.js");
    const { runDiagnostics, checkProviderHealth, checkSlackTokens } = await import("../diagnostics.js");
    try {
      const configs = loadAllAgentConfigs();
      console.log(`Config loaded: ${configs.length} agent(s) — ${configs.map((a) => a.id).join(", ")}`);
      for (const c of configs) {
        const skills = loadSkills({ ...c.skillSources, legacyDirs: c.skillsDirs });
        const wFiles = loadWorkspaceFiles(c.workspaceDir);
        const parts = [
          `  ${c.id}: ${c.provider}/${c.model}`,
          wFiles.length > 0 ? `workspace: ${wFiles.map((f) => f.name).join(", ")}` : "no workspace files",
          skills.length > 0 ? `skills: ${skills.map((s) => s.name).join(", ")}` : "no skills",
        ];
        console.log(parts.join(" | "));
      }
      runDiagnostics(configs);
      const results = await Promise.allSettled([checkProviderHealth(configs), checkSlackTokens(configs)]);
      let hasErrors = false;
      for (const r of results) {
        if (r.status === "rejected") {
          console.error(`Error: ${r.reason}`);
          hasErrors = true;
        }
      }
      if (!hasErrors) console.log("All checks passed.");
      else process.exit(1);
    } catch (err) {
      console.error(`Config error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// ─── Run ─────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof WizardCancelledError) {
    process.exit(0);
  }
  console.error(err.message ?? err);
  process.exit(1);
});
