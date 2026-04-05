import type { ToolDefinition, ToolUseContext } from "./types.js";
import type { ToolCall } from "./provider.js";
import { errMsg } from "./utils/errors.js";
import { sanitizeForUser } from "./utils/sanitize.js";
import { createLogger } from "./utils/logger.js";
import { recordToolUsage } from "./utils/token-tracker.js";

const log = createLogger("tool-runner");

const MAX_CONCURRENCY = 10;

/**
 * Maximum characters per tool result before truncation.
 * ~25K tokens × 4 chars/token = 100K chars.
 * Ported from claude-code's DEFAULT_MAX_MCP_OUTPUT_TOKENS (25000) × 4.
 */
const MAX_TOOL_OUTPUT_CHARS = 100_000;

/**
 * Per-tool execution timeout (2 minutes).
 * Prevents runaway tools from blocking the agent loop indefinitely.
 * Ported from claude-code's tool-level timeout pattern.
 */
const TOOL_EXECUTION_TIMEOUT_MS = 120_000;

/** Log a warning when a tool takes longer than this. */
const SLOW_TOOL_LOG_THRESHOLD_MS = 1_000;

export interface ToolResult {
  callId: string;
  name: string;
  output: string;
  /** If true, the tool execution failed. Ported from claude-code's is_error pattern. */
  isError?: boolean;
}

// ─── Batch execution ──────────────────────────────────────────────────

/**
 * Execute tool calls with concurrency support.
 * Consecutive read-only tools run concurrently; write tools run serially.
 * Ported from claude-code's toolOrchestration.ts partitionToolCalls pattern.
 */
export async function runToolBatch(
  tools: ToolDefinition[],
  toolCalls: ToolCall[],
  context?: ToolUseContext,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  // Build lookup map once instead of O(n) find per tool call
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const batches = partitionToolCalls(toolMap, toolCalls);

  for (const batch of batches) {
    if (batch.concurrent) {
      const batchResults = await Promise.all(
        batch.calls.map((tc) => executeOne(toolMap, tc, context)),
      );
      results.push(...batchResults);
    } else {
      for (const tc of batch.calls) {
        results.push(await executeOne(toolMap, tc, context));
      }
    }
  }

  return results;
}

// ─── Partitioning ─────────────────────────────────────────────────────

interface Batch {
  concurrent: boolean;
  calls: ToolCall[];
}

/**
 * Partition tool calls into batches:
 * - Consecutive read-only tools → one concurrent batch
 * - Each non-read-only tool → its own serial batch
 */
function partitionToolCalls(toolMap: Map<string, ToolDefinition>, toolCalls: ToolCall[]): Batch[] {
  const batches: Batch[] = [];

  for (const tc of toolCalls) {
    const tool = toolMap.get(tc.name);
    const isReadOnly = tool?.isReadOnly ?? false;

    if (isReadOnly) {
      // Merge into the last batch if it's also concurrent
      const last = batches[batches.length - 1];
      if (last && last.concurrent && last.calls.length < MAX_CONCURRENCY) {
        last.calls.push(tc);
      } else {
        batches.push({ concurrent: true, calls: [tc] });
      }
    } else {
      batches.push({ concurrent: false, calls: [tc] });
    }
  }

  return batches;
}

// ─── Single tool execution ────────────────────────────────────────────

async function executeOne(toolMap: Map<string, ToolDefinition>, tc: ToolCall, context?: ToolUseContext): Promise<ToolResult> {
  const tool = toolMap.get(tc.name);
  if (!tool) {
    log.warn(`Model called unknown tool "${tc.name}" — available: ${[...toolMap.keys()].join(", ")}`);
    return { callId: tc.id, name: tc.name, output: `Unknown tool: ${tc.name}`, isError: true };
  }
  const startMs = Date.now();
  if (context?.agentId) recordToolUsage(context.agentId, tc.name);
  try {
    // Parse arguments, handling empty/malformed JSON gracefully.
    // Ported from claude-code's tool argument validation pattern.
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
    } catch {
      return { callId: tc.id, name: tc.name, output: `Error: Invalid JSON in tool arguments for ${tc.name}`, isError: true };
    }
    // Execute with a timeout to prevent runaway tools from blocking the agent loop
    const timeout = tool.timeoutMs ?? TOOL_EXECUTION_TIMEOUT_MS;
    let output = await withTimeout(tool.execute(args, context), timeout, tc.name);
    const elapsed = Date.now() - startMs;
    if (elapsed > SLOW_TOOL_LOG_THRESHOLD_MS) {
      const argHint = tc.arguments.length > 80 ? tc.arguments.slice(0, 80) + "..." : tc.arguments;
      log.debug(`${tc.name} took ${(elapsed / 1000).toFixed(1)}s | args: ${argHint}`);
    }
    // Detect tool-level errors (tools return error strings rather than throwing).
    // Ported from claude-code's tool error detection pattern.
    const isError = /^(error\s*:|error\s|blocked:|\[error\])/i.test(output);
    output = truncateToolOutput(output, tc.name);
    return { callId: tc.id, name: tc.name, output, ...(isError ? { isError } : {}) };
  } catch (err) {
    const elapsed = Date.now() - startMs;
    const msg = errMsg(err);
    // Include truncated args summary for debugging (e.g. which file, which command)
    const argsSummary = tc.arguments.length > 120 ? tc.arguments.slice(0, 120) + "..." : tc.arguments;
    log.error(`${tc.name} failed after ${(elapsed / 1000).toFixed(1)}s: ${msg.slice(0, 200)} | args: ${argsSummary}`);
    // Friendly timeout message (ported from claude-code's FallbackToolUseErrorMessage pattern)
    if (msg.includes("timed out") || msg.includes("TIMEOUT")) {
      return { callId: tc.id, name: tc.name, output: `The ${tc.name} tool timed out after ${Math.round(elapsed / 1000)}s. Try a simpler command or break it into smaller steps.`, isError: true };
    }
    return { callId: tc.id, name: tc.name, output: `Tool execution error: ${sanitizeForUser(msg)}`, isError: true };
  }
}

/**
 * Truncate tool output to prevent context window bloat.
 * Ported from claude-code's truncateString / mcpValidation pattern.
 */
function truncateToolOutput(output: string, toolName: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;

  const truncated = output.slice(0, MAX_TOOL_OUTPUT_CHARS);

  // Try to break at a newline to avoid mid-line truncation
  const lastNewline = truncated.lastIndexOf("\n", MAX_TOOL_OUTPUT_CHARS - 200);
  const breakPoint = lastNewline > MAX_TOOL_OUTPUT_CHARS * 0.8 ? lastNewline : MAX_TOOL_OUTPUT_CHARS;

  const originalLines = output.split("\n").length;
  const keptLines = output.slice(0, breakPoint).split("\n").length;

  log.debug(`Truncated ${toolName} output: ${output.length} → ${breakPoint} chars (${keptLines}/${originalLines} lines)`);

  return output.slice(0, breakPoint) + `\n\n[Truncated: showing ${keptLines} of ${originalLines} lines. Output was ${Math.round(output.length / 1024)}KB — use offset/limit parameters to read specific sections.]`;
}

/**
 * Race a promise against a timeout. Ported from claude-code's tool-level timeout pattern.
 */
function withTimeout(promise: Promise<string>, ms: number, toolName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool "${toolName}" timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    if (timer.unref) timer.unref();
    promise
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}
