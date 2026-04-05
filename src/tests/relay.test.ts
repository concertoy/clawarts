import { describe, it, expect, beforeEach } from "vitest";
import {
  registerAgent,
  getAgentStartedAt,
  getRegisteredAgent,
  listRegisteredAgentIds,
  touchAgent,
  getAgentLastActive,
  recordAgentError,
  getAgentLastError,
  getStudentsForTutor,
} from "../relay.js";

// Minimal mocks for Agent, SessionStore, WebClient
const mockAgent = {} as any;
const mockSessions = {} as any;
const mockClient = {} as any;

describe("relay registry", () => {
  beforeEach(() => {
    // Register fresh agents for each test
    registerAgent({ id: "tutor", agent: mockAgent, sessions: mockSessions, slackClient: mockClient });
    registerAgent({
      id: "student-1",
      agent: mockAgent,
      sessions: mockSessions,
      slackClient: mockClient,
      linkedTutor: "tutor",
      allowedUsers: ["U111"],
    });
    registerAgent({
      id: "student-2",
      agent: mockAgent,
      sessions: mockSessions,
      slackClient: mockClient,
      linkedTutor: "tutor",
      allowedUsers: ["U222"],
    });
  });

  it("registers and retrieves agents", () => {
    expect(getRegisteredAgent("tutor")).toBeDefined();
    expect(getRegisteredAgent("nonexistent")).toBeUndefined();
  });

  it("lists all registered agent IDs", () => {
    const ids = listRegisteredAgentIds();
    expect(ids).toContain("tutor");
    expect(ids).toContain("student-1");
  });

  it("records agent started-at time", () => {
    const ts = getAgentStartedAt("tutor");
    expect(ts).toBeGreaterThan(0);
  });

  it("tracks last active time", () => {
    touchAgent("tutor");
    const ts = getAgentLastActive("tutor");
    expect(ts).toBeGreaterThan(0);
  });

  it("records and retrieves errors", () => {
    recordAgentError("tutor", "test error");
    expect(getAgentLastError("tutor")).toBe("test error");
  });

  it("finds students for a tutor", () => {
    const students = getStudentsForTutor("tutor");
    expect(students).toHaveLength(2);
    expect(students.map((s) => s.id)).toContain("student-1");
    expect(students.map((s) => s.id)).toContain("student-2");
  });

  it("returns empty array for tutor with no students", () => {
    expect(getStudentsForTutor("nonexistent")).toEqual([]);
  });
});
