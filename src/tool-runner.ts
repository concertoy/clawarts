import type { ToolDefinition } from "./types.js";
import type { ToolCall } from "./provider.js";

const MAX_CONCURRENCY = 10;

export interface ToolResult {
  callId: string;
  name: string;
  output: string;
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
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  const batches = partitionToolCalls(tools, toolCalls);

  for (const batch of batches) {
    if (batch.concurrent) {
      // Run read-only batch concurrently (capped at MAX_CONCURRENCY)
      const batchResults = await Promise.all(
        batch.calls.map((tc) => executeOne(tools, tc)),
      );
      results.push(...batchResults);
    } else {
      // Run write batch serially
      for (const tc of batch.calls) {
        results.push(await executeOne(tools, tc));
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

async function executeOne(tools: ToolDefinition[], tc: ToolCall): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === tc.name);
  if (!tool) {
    return { callId: tc.id, name: tc.name, output: `Unknown tool: ${tc.name}` };
  }
  try {
    const args = JSON.parse(tc.arguments) as Record<string, unknown>;
    const output = await tool.execute(args);
    return { callId: tc.id, name: tc.name, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { callId: tc.id, name: tc.name, output: `Tool execution error: ${msg}` };
  }
}
