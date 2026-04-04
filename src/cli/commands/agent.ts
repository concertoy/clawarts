import type { AgentEntry, Provider } from "../../types.js";
import type { WizardPrompter } from "../prompter.js";
import type { AgentType } from "../templates.js";
import { readConfig, writeConfig, addAgent, removeAgent, findAgent, findLinkedStudents, findTutors, agentIdToEnvPrefix, resolveWorkspaceDir } from "../config-io.js";
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
      { value: "student", label: "Student", hint: "Restricted tools, nested under a tutor's workspace" },
      { value: "custom", label: "Custom", hint: "Configure everything manually" },
    ],
  });

  // Student agents must be linked to a tutor
  let linkedTutor: string | undefined;
  if (agentType === "student") {
    const tutors = findTutors(config);
    if (tutors.length === 0) {
      await prompter.note(
        "Student agents must be linked to a tutor agent.\nAdd a tutor agent first, then add the student.",
        "No tutor agents found",
      );
      throw new Error("No tutor agents available. Create a tutor agent first.");
    }

    linkedTutor = await prompter.select<string>({
      message: "Link to tutor:",
      options: tutors.map((t) => ({
        value: t.id,
        label: t.id,
        hint: `workspace: ${resolveWorkspaceDir(t)}`,
      })),
    });
  }

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
      linkedTutor,
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
      linkedTutor,
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

  // Allowed users (Slack user IDs that can interact with this agent)
  const allowedUsersInput = await prompter.text({
    message: "Allowed Slack user IDs (comma-separated, blank for unrestricted):",
    placeholder: "e.g. U07ERPSNP6X, U08ABCD1234",
    initialValue: "",
  });
  if (allowedUsersInput.trim()) {
    entry.allowedUsers = allowedUsersInput.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // Write config
  const updated = addAgent(config, entry);
  writeConfig(updated);

  // Scaffold workspace (resolve with full config for nested student workspaces)
  const workspaceDir = resolveWorkspaceDir(entry, updated);
  const result = scaffoldWorkspace(id, workspaceDir, agentType);

  const noteLines = [`Workspace: ${workspaceDir}`];
  if (linkedTutor) noteLines.push(`Linked to tutor: ${linkedTutor}`);
  if (result.created.length > 0) noteLines.push(`Created: ${result.created.join(", ")}`);
  if (result.skipped.length > 0) noteLines.push(`Skipped (exist): ${result.skipped.join(", ")}`);

  await prompter.note(noteLines.join("\n"), `Agent "${id}" created`);
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
    const linked = agent.linkedTutor ? ` → tutor: ${agent.linkedTutor}` : "";
    const students = findLinkedStudents(config, agent.id);
    const studentInfo = students.length > 0 ? ` (${students.length} student${students.length > 1 ? "s" : ""}: ${students.map((s) => s.id).join(", ")})` : "";

    console.log(`  ${agent.id}${linked}${studentInfo}`);
    console.log(`    provider: ${provider}  model: ${model}`);
    console.log(`    tools: ${tools}`);
    console.log(`    workspace: ${resolveWorkspaceDir(agent, config)}`);
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

  // Block removing a tutor that still has linked students
  const students = findLinkedStudents(config, id);
  if (students.length > 0) {
    console.log(`Cannot remove tutor "${id}" — it has ${students.length} linked student(s): ${students.map((s) => s.id).join(", ")}`);
    console.log("Remove the student agents first.");
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
  const workspaceDir = resolveWorkspaceDir(agent, config);
  const removeWorkspace = await prompter.confirm({
    message: `Also delete workspace at ${workspaceDir}?`,
    initialValue: false,
  });

  if (removeWorkspace) {
    const fs = await import("node:fs");
    const os = await import("node:os");
    // Safety: prevent deletion of dangerous paths
    const home = os.homedir();
    const normalized = workspaceDir.replace(/\/+$/, "");
    if (
      normalized === "/" ||
      normalized === home ||
      normalized === "/tmp" ||
      normalized.split("/").filter(Boolean).length < 3
    ) {
      console.error(`Refusing to delete "${workspaceDir}" — path looks too broad. Remove manually if intended.`);
    } else {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      console.log(`Workspace deleted: ${workspaceDir}`);
    }
  }
}
