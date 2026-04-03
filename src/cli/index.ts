#!/usr/bin/env node
import { Command } from "commander";
import { createClackPrompter, WizardCancelledError } from "./prompter.js";
import { setupWizardCommand } from "./commands/setup.js";
import { agentAddCommand, agentListCommand, agentRemoveCommand } from "./commands/agent.js";
import { skillAddCommand, skillListCommand, skillRemoveCommand } from "./commands/skill.js";

const program = new Command()
  .name("clawarts")
  .description("Configure and manage clawarts Slack agents")
  .version("0.1.0");

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

// ─── Run ─────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof WizardCancelledError) {
    process.exit(0);
  }
  console.error(err.message ?? err);
  process.exit(1);
});
