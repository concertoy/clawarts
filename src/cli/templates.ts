import type { Provider } from "../types.js";

// ─── Template shape ──────────────────────────────────────────────────

export interface AgentTemplate {
  provider: Provider;
  model: string;
  maxTokens: number;
  sessionTtlMinutes: number;
  systemPrompt: string;
  disallowedTools?: string[];
  thinkingBudgetTokens?: number;
}

export type AgentType = "tutor" | "student" | "custom";

// ─── Model defaults per provider ─────────────────────────────────────

const TUTOR_MODELS: Record<Provider, string> = {
  "anthropic-claude": "claude-sonnet-4-20250514",
  "openai-codex": "gpt-5.4",
};

const STUDENT_MODELS: Record<Provider, string> = {
  "anthropic-claude": "claude-haiku-4-5-20250514",
  "openai-codex": "gpt-5.4",
};

// ─── Templates ───────────────────────────────────────────────────────

export function getTutorTemplate(provider: Provider): AgentTemplate {
  return {
    provider,
    model: TUTOR_MODELS[provider],
    maxTokens: 16384,
    sessionTtlMinutes: 120,
    thinkingBudgetTokens: 8192,
    systemPrompt: [
      "You are a course tutor assistant in a Slack workspace.",
      "You help students learn by guiding them through problems, explaining concepts clearly, and providing constructive feedback.",
      "You have full access to workspace tools for creating materials, running code examples, and managing course content.",
      "Be patient, encouraging, and precise. Break complex topics into manageable steps.",
      "When students make mistakes, use them as teaching opportunities rather than just giving the answer.",
    ].join(" "),
  };
}

export function getStudentTemplate(provider: Provider): AgentTemplate {
  return {
    provider,
    model: STUDENT_MODELS[provider],
    maxTokens: 4096,
    sessionTtlMinutes: 60,
    disallowedTools: ["bash", "write_file", "edit", "multi_edit"],
    systemPrompt: [
      "You are a student learning assistant in a Slack workspace.",
      "Help the student practice problems, ask guiding questions, and encourage independent problem-solving.",
      "You can read files and search the web to find information, but you cannot modify files or run shell commands.",
      "Focus on understanding over answers. When a student asks for help, guide them to discover the solution rather than providing it directly.",
    ].join(" "),
  };
}

export function getTemplate(type: AgentType, provider: Provider): AgentTemplate | null {
  switch (type) {
    case "tutor": return getTutorTemplate(provider);
    case "student": return getStudentTemplate(provider);
    case "custom": return null;
  }
}
