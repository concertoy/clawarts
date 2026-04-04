import type { ToolDefinition, ToolUseContext } from "./types.js";
import type { ToolCall } from "./provider.js";
import { errMsg } from "./utils/errors.js";

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
  const batches = partitionToolCalls(tools, toolCalls);

  for (const batch of batches) {
    if (batch.concurrent) {
      const batchResults = await Promise.all(
        batch.calls.map((tc) => executeOne(tools, tc, context)),
      );
      results.push(...batchResults);
    } else {
      for (const tc of batch.calls) {
        results.push(await executeOne(tools, tc, context));
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
function partitionToolCalls(tools: ToolDefinition[], toolCalls: ToolCall[]): Batch[] {
  const batches: Batch[] = [];

  for (const tc of toolCalls) {
    const tool = tools.find((t) => t.name === tc.name);
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

async function executeOne(tools: ToolDefinition[], tc: ToolCall, context?: ToolUseContext): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === tc.name);
  if (!tool) {
    return { callId: tc.id, name: tc.name, output: `Unknown tool: ${tc.name}`, isError: true };
  }
  const startMs = Date.now();
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
    let output = await withTimeout(tool.execute(args, context), TOOL_EXECUTION_TIMEOUT_MS, tc.name);
    const elapsed = Date.now() - startMs;
    if (elapsed > 1000) console.log(`[tool-runner] ${tc.name} took ${(elapsed / 1000).toFixed(1)}s`);
    // Detect tool-level errors (tools return error strings rather than throwing).
    // Ported from claude-code's tool error detection pattern.
    const isError = /^(error\s*:|error\s|blocked:|\[error\])/i.test(output);
    output = truncateToolOutput(output, tc.name);
    return { callId: tc.id, name: tc.name, output, isError: isError || undefined };
  } catch (err) {
    const elapsed = Date.now() - startMs;
    const msg = errMsg(err);
    console.error(`[tool-runner] ${tc.name} failed after ${(elapsed / 1000).toFixed(1)}s: ${msg.slice(0, 100)}`);
    return { callId: tc.id, name: tc.name, output: `Tool execution error: ${msg}`, isError: true };
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

  console.log(`[tool-runner] Truncated ${toolName} output: ${output.length} → ${breakPoint} chars (${keptLines}/${originalLines} lines)`);

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
