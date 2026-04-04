/**
 * Tool that lets the agent upload files to the current Slack channel/thread.
 * Closure-based — captures the WebClient at creation time (same pattern as createCronTool, createRelayTool).
 */

import type { WebClient } from "@slack/web-api";
import type { ToolDefinition, ToolUseContext } from "./types.js";
import { errMsg } from "./utils/errors.js";

const MAX_CONTENT_BYTES = 1 * 1024 * 1024; // 1MB text limit

export function createSlackUploadTool(slackClient: WebClient): ToolDefinition {
  return {
    name: "slack_upload",
    description:
      "Upload a file to the current Slack conversation. Use this to share generated code, reports, data files, or any content that is best delivered as a downloadable file attachment rather than inline text. The file appears in the same channel and thread as the current conversation.",
    category: "utility",
    isReadOnly: false,
    parameters: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "File name including extension (e.g. 'report.csv', 'script.py', 'output.json')",
        },
        content: {
          type: "string",
          description: "The text content of the file",
        },
        title: {
          type: "string",
          description: "Optional display title for the file in Slack",
        },
        comment: {
          type: "string",
          description: "Optional message to accompany the file upload",
        },
      },
      required: ["filename", "content"],
    },

    async execute(input: Record<string, unknown>, context?: ToolUseContext): Promise<string> {
      const filename = input.filename as string;
      const content = input.content as string;
      const title = input.title as string | undefined;
      const comment = input.comment as string | undefined;

      if (!filename || !content) {
        return "Error: filename and content are required";
      }

      if (Buffer.byteLength(content, "utf-8") > MAX_CONTENT_BYTES) {
        return `Error: content exceeds ${MAX_CONTENT_BYTES / 1024 / 1024}MB limit`;
      }

      if (!context?.channelId) {
        return "Error: no channel context available for upload";
      }

      try {
        await slackClient.files.uploadV2({
          channel_id: context.channelId,
          filename,
          content,
          title: title ?? filename,
          ...(context.threadTs ? { thread_ts: context.threadTs } : {}),
          ...(comment ? { initial_comment: comment } : {}),
        } as Parameters<typeof slackClient.files.uploadV2>[0]);

        return `File "${filename}" uploaded successfully to the conversation.`;
      } catch (err) {
        return `Error uploading file: ${errMsg(err)}`;
      }
    },
  };
}
