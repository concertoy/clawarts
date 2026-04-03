import type { Provider } from "../../types.js";
import type { WizardPrompter } from "../prompter.js";
import { readConfig, writeConfig, agentIdToEnvPrefix } from "../config-io.js";
import { agentAddCommand } from "./agent.js";

// ─── Setup wizard ────────────────────────────────────────────────────

export async function setupWizardCommand(prompter: WizardPrompter): Promise<void> {
  await prompter.intro("clawarts setup");

  const config = readConfig();

  // Detect existing config
  if (config.agents.length > 0) {
    const agentNames = config.agents.map((a) => a.id).join(", ");
    await prompter.note(
      `${config.agents.length} agent(s): ${agentNames}\nDefault provider: ${config.defaults.provider ?? "openai-codex"}`,
      "Existing config detected",
    );

    const action = await prompter.select<"use" | "modify" | "reset">({
      message: "What would you like to do?",
      options: [
        { value: "modify", label: "Modify", hint: "Add/change agents in existing config" },
        { value: "use", label: "Use existing", hint: "Keep current config, exit" },
        { value: "reset", label: "Reset", hint: "Start fresh" },
      ],
    });

    if (action === "use") {
      await prompter.outro("Config unchanged.");
      return;
    }

    if (action === "reset") {
      config.agents = [];
      config.defaults = {};
    }
  }

  // Default provider
  const provider = await prompter.select<Provider>({
    message: "Default provider:",
    options: [
      { value: "anthropic-claude", label: "Anthropic Claude", hint: "claude-sonnet-4, claude-haiku-4.5" },
      { value: "openai-codex", label: "OpenAI Codex", hint: "gpt-5.4" },
    ],
    initialValue: (config.defaults.provider as Provider) ?? undefined,
  });
  config.defaults.provider = provider;

  // Write initial defaults
  writeConfig(config);

  // Agent creation loop
  let addMore = true;
  while (addMore) {
    const shouldAdd = await prompter.confirm({
      message: config.agents.length === 0 ? "Add an agent?" : "Add another agent?",
      initialValue: config.agents.length === 0,
    });

    if (!shouldAdd) break;

    await agentAddCommand(prompter);
    // Re-read config since agentAddCommand writes to it
    const updated = readConfig();
    config.agents = updated.agents;

    addMore = true;
  }

  // Show required env vars
  if (config.agents.length > 0) {
    const envVars: string[] = [];
    for (const agent of config.agents) {
      const prefix = agentIdToEnvPrefix(agent.id);
      // Show the actual var names from config (strip $ prefix)
      const botVar = agent.slackBotToken.startsWith("$") ? agent.slackBotToken.slice(1) : `${prefix}_SLACK_BOT_TOKEN`;
      const appVar = agent.slackAppToken.startsWith("$") ? agent.slackAppToken.slice(1) : `${prefix}_SLACK_APP_TOKEN`;
      envVars.push(`${botVar}=xoxb-...`);
      envVars.push(`${appVar}=xapp-...`);
    }

    // Provider-specific API keys
    const providers = new Set(config.agents.map((a) => a.provider ?? config.defaults.provider));
    if (providers.has("anthropic-claude")) {
      envVars.push("ANTHROPIC_API_KEY=sk-ant-...");
    }

    await prompter.note(
      `Add these to your .env file:\n\n${envVars.join("\n")}`,
      "Environment variables needed",
    );
  }

  await prompter.outro("Setup complete! Run `npm start` to launch.");
}
