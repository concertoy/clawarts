/**
 * Per-agent tool wiring — extracted from index.ts for readability.
 * Creates the full tool set for a tutor or student agent.
 */
import path from "node:path";
import type { AgentConfig, ToolDefinition } from "./types.js";
import type { CronService } from "./cron/service.js";
import { createToolRegistry } from "./tools.js";
import { filterToolsForAgent } from "./tool-filter.js";
import { createRelayTool, createListStudentsTool } from "./relay.js";
import { createSlackUploadTool } from "./slack-upload-tool.js";
import { AssignmentStore } from "./store/assignment-store.js";
import { SubmissionStore } from "./store/submission-store.js";
import { CheckinStore } from "./store/checkin-store.js";
import { createAssignmentTool } from "./tools/assignment-tool.js";
import { createSubmitTool } from "./tools/submit-tool.js";
import { createCheckinTool } from "./tools/checkin-tool.js";
import { createCheckinRespondTool } from "./tools/checkin-respond-tool.js";
import { createStatusTool } from "./tools/status-tool.js";
import { createMyStatusTool } from "./tools/my-status-tool.js";
import { createExportTool } from "./tools/export-tool.js";
import { createResetTool } from "./tools/reset-tool.js";
import { createHelpTool } from "./tools/help-tool.js";
import { createGradesTool } from "./tools/grades-tool.js";
import type { WebClient } from "@slack/web-api";
import { clawHome } from "./utils/paths.js";
import { errMsg } from "./utils/errors.js";
import { createLogger } from "./utils/logger.js";

export interface AgentToolsResult {
  tools: ToolDefinition[];
  /** System message handler for cron jobs (tutor only). */
  cronSystemHandler?: (tag: string, params: Record<string, string>) => Promise<boolean>;
}

export function createAgentTools(
  config: AgentConfig,
  cronService: CronService,
  slackClient: WebClient,
): AgentToolsResult {
  const log = createLogger(`tools:${config.id}`);
  const allTools = createToolRegistry(config.workspaceDir, { cronService, agentId: config.id });
  const isTutor = !config.linkedTutor;

  let cronSystemHandler: AgentToolsResult["cronSystemHandler"];

  if (isTutor) {
    allTools.push(createRelayTool());
    allTools.push(createListStudentsTool());

    const dataDir = clawHome("agents", config.id, "data");
    const assignmentStore = new AssignmentStore(path.join(dataDir, "assignments.json"));
    // Sweep overdue assignments on startup (may remain if process crashed before cron auto-close fired)
    assignmentStore.closeExpired().catch((err) => log.warn("Failed to auto-close expired assignments:", errMsg(err)));
    const submissionStore = new SubmissionStore(path.join(dataDir, "submissions.json"));
    allTools.push(createAssignmentTool(assignmentStore, submissionStore, cronService, config.id));

    const checkinStore = new CheckinStore(dataDir);
    // Sweep stale open windows on startup (may remain if process crashed before cron auto-close fired)
    checkinStore.closeExpiredWindows().catch((err) => log.warn("Failed to close expired check-in windows:", errMsg(err)));
    allTools.push(createCheckinTool(checkinStore, cronService, config.id));
    allTools.push(createStatusTool(cronService));
    allTools.push(createExportTool());
    allTools.push(createResetTool());
    allTools.push(createGradesTool(assignmentStore, submissionStore, checkinStore));

    cronSystemHandler = async (tag, params) => {
      if (tag === "CLOSE_ASSIGNMENT" && params.assignmentId) {
        await assignmentStore.close(params.assignmentId);
        return true;
      }
      if (tag === "CLOSE_CHECKIN" && params.windowId) {
        await checkinStore.closeWindow(params.windowId);
        return true;
      }
      if (tag === "PULSE_CHECKIN" && params.pulseGroupId) {
        const toInt = (v: string | undefined, fallback: number) => parseInt(v ?? "", 10) || fallback;
        const duration = toInt(params.durationMinutes, 2) * 60 * 1000;
        const pulseIndex = toInt(params.pulseIndex, 1);
        const pulseTotal = toInt(params.pulseTotal, 1);
        await checkinStore.createWindow({
          tutorId: config.id,
          mode: "pulse",
          topic: params.topic || undefined,
          pulseGroupId: params.pulseGroupId,
          pulseIndex,
          pulseTotal,
          closesAt: Date.now() + duration,
        });
        return true;
      }
      return false;
    };
  } else if (config.linkedTutor) {
    const tutorDataDir = clawHome("agents", config.linkedTutor, "data");
    const assignmentStore = new AssignmentStore(path.join(tutorDataDir, "assignments.json"));
    const submissionStore = new SubmissionStore(path.join(tutorDataDir, "submissions.json"));
    allTools.push(createSubmitTool(assignmentStore, submissionStore));

    const checkinStore = new CheckinStore(tutorDataDir);
    allTools.push(createCheckinRespondTool(checkinStore));
    allTools.push(createMyStatusTool(assignmentStore, submissionStore, checkinStore));
  }

  allTools.push(createSlackUploadTool(slackClient));

  const tools = filterToolsForAgent(allTools, config);
  tools.push(createHelpTool(tools));

  return { tools, cronSystemHandler };
}
