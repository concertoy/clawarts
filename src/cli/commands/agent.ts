import type { AgentEntry, Provider } from "../../types.js";
import type { WizardPrompter } from "../prompter.js";
import type { AgentType } from "../templates.js";
import { readConfig, writeConfig, addAgent, removeAgent, findAgent, agentIdToEnvPrefix, resolveWorkspaceDir } from "../config-io.js";
import { getTemplate } from "../templates.js";
import { scaffoldWorkspace } from "../scaffold.js";

// ─── agent add ───────────────────────────────────────────────────────

/**
 * Interactive agent creation flow.
 * Returns the created AgentEntry (also written to config.json).
 */
export async function agentAddCommand(prompter: WizardPrompter): Promise<AgentEntry> {
  const config = readConfig();

  // Agent ID
  const id = await prompter.text({
    message: "Agent ID:",
    placeholder: "e.g. tutor, student-1",
    validate: (value) => {
      if (!value) return "Agent ID is required";
      if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) return "Use lowercase letters, numbers, and hyphens";
      if (findAgent(config, value)) return `Agent "${value}" already exists`;
      return undefined;
    },
  });

  // Agent type
  const agentType = await prompter.select<AgentType>({
    message: "Agent type:",
    options: [
      { value: "tutor", label: "Tutor", hint: "Full tool access, teaching-oriented, higher-tier model" },
      { value: "student", label: "Student", hint: "Restricted tools, learning-oriented, lighter model" },
      { value: "custom", label: "Custom", hint: "Configure everything manually" },
    ],
  });

  // Provider
  const provider = await prompter.select<Provider>({
    message: "Provider:",
    options: [
      { value: "anthropic-claude", label: "Anthropic Claude", hint: "claude-sonnet-4 / claude-haiku-4.5" },
      { value: "openai-codex", label: "OpenAI Codex", hint: "gpt-5.4" },
    ],
  });

  // Build entry from template or custom prompts
  const template = getTemplate(agentType, provider);

  let entry: AgentEntry;
  if (template) {
    entry = {
      id,
      slackBotToken: `$${agentIdToEnvPrefix(id)}_SLACK_BOT_TOKEN`,
      slackAppToken: `$${agentIdToEnvPrefix(id)}_SLACK_APP_TOKEN`,
      provider: template.provider,
      model: template.model,
      maxTokens: template.maxTokens,
      sessionTtlMinutes: template.sessionTtlMinutes,
      systemPrompt: template.systemPrompt,
      disallowedTools: template.disallowedTools,
      thinkingBudgetTokens: template.thinkingBudgetTokens,
    };
  } else {
    // Custom: prompt for each field
    const model = await prompter.text({
      message: "Model:",
      initialValue: provider === "anthropic-claude" ? "claude-sonnet-4-20250514" : "gpt-5.4",
    });

    const systemPrompt = await prompter.text({
      message: "System prompt:",
      initialValue: "You are a helpful assistant in a Slack workspace.",
    });

    entry = {
      id,
      slackBotToken: `$${agentIdToEnvPrefix(id)}_SLACK_BOT_TOKEN`,
      slackAppToken: `$${agentIdToEnvPrefix(id)}_SLACK_APP_TOKEN`,
      provider,
      model,
      systemPrompt,
    };
  }

  // Slack token env var names (allow override)
  const prefix = agentIdToEnvPrefix(id);
  const botTokenVar = await prompter.text({
    message: "Slack Bot Token env var:",
    initialValue: `$${prefix}_SLACK_BOT_TOKEN`,
  });
  const appTokenVar = await prompter.text({
    message: "Slack App Token env var:",
    initialValue: `$${prefix}_SLACK_APP_TOKEN`,
  });
  entry.slackBotToken = botTokenVar;
  entry.slackAppToken = appTokenVar;

  // Write config
  const updated = addAgent(config, entry);
  writeConfig(updated);

  // Scaffold workspace
  const workspaceDir = resolveWorkspaceDir(entry);
  const result = scaffoldWorkspace(id, workspaceDir, agentType);

  if (result.created.length > 0) {
    await prompter.note(
      `Workspace: ${workspaceDir}\nCreated: ${result.created.join(", ")}${result.skipped.length > 0 ? `\nSkipped (exist): ${result.skipped.join(", ")}` : ""}`,
      `Agent "${id}" created`,
    );
  } else {
    await prompter.note(`Workspace: ${workspaceDir}`, `Agent "${id}" created`);
  }

  return entry;
}

// ─── agent list ──────────────────────────────────────────────────────

export function agentListCommand(): void {
  const config = readConfig();

  if (config.agents.length === 0) {
    console.log("No agents configured. Run `clawarts setup` or `clawarts agent add` to create one.");
    return;
  }

  console.log(`\n  ${config.agents.length} agent(s):\n`);
  for (const agent of config.agents) {
    const provider = agent.provider ?? config.defaults.provider ?? "openai-codex";
    const model = agent.model ?? config.defaults.model ?? "—";
    const tools = agent.disallowedTools?.length ? `restricted (${agent.disallowedTools.length} denied)` : "full access";
    console.log(`  ${agent.id}`);
    console.log(`    provider: ${provider}  model: ${model}`);
    console.log(`    tools: ${tools}`);
    console.log();
  }
}

// ─── agent remove ────────────────────────────────────────────────────

export async function agentRemoveCommand(prompter: WizardPrompter, id: string): Promise<void> {
  const config = readConfig();
  const agent = findAgent(config, id);

  if (!agent) {
    console.log(`Agent "${id}" not found.`);
    return;
  }

  const confirmed = await prompter.confirm({
    message: `Remove agent "${id}"?`,
    initialValue: false,
  });

  if (!confirmed) {
    console.log("Cancelled.");
    return;
  }

  const updated = removeAgent(config, id);
  writeConfig(updated);
  console.log(`Agent "${id}" removed from config.json.`);

  // Optionally remove workspace
  const workspaceDir = resolveWorkspaceDir(agent);
  const removeWorkspace = await prompter.confirm({
    message: `Also delete workspace at ${workspaceDir}?`,
    initialValue: false,
  });

  if (removeWorkspace) {
    const fs = await import("node:fs");
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    console.log(`Workspace deleted: ${workspaceDir}`);
  }
}
