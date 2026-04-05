import { describe, it, expect } from "vitest";
import { runToolBatch, type ToolResult } from "../tool-runner.js";
import type { ToolDefinition } from "../types.js";

function makeTool(name: string, opts?: { isReadOnly?: boolean; execute?: (input: Record<string, unknown>) => Promise<string> }): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    parameters: { type: "object", properties: {} },
    isReadOnly: opts?.isReadOnly ?? false,
    category: "utility",
    execute: opts?.execute ?? (async () => `result from ${name}`),
  };
}

describe("runToolBatch", () => {
  it("executes a single tool", async () => {
    const tools = [makeTool("echo", { execute: async () => "hello" })];
    const calls = [{ id: "1", name: "echo", arguments: "{}" }];
    const results = await runToolBatch(tools, calls);
    expect(results).toHaveLength(1);
    expect(results[0].output).toBe("hello");
    expect(results[0].callId).toBe("1");
  });

  it("returns error for unknown tool", async () => {
    const results = await runToolBatch([], [{ id: "1", name: "missing", arguments: "{}" }]);
    expect(results[0].isError).toBe(true);
    expect(results[0].output).toContain("Unknown tool");
  });

  it("returns error for invalid JSON arguments", async () => {
    const tools = [makeTool("test")];
    const results = await runToolBatch(tools, [{ id: "1", name: "test", arguments: "not json" }]);
    expect(results[0].isError).toBe(true);
    expect(results[0].output).toContain("Invalid JSON");
  });

  it("detects error-prefixed output", async () => {
    const tools = [makeTool("fail", { execute: async () => "Error: something broke" })];
    const results = await runToolBatch(tools, [{ id: "1", name: "fail", arguments: "{}" }]);
    expect(results[0].isError).toBe(true);
  });

  it("runs read-only tools concurrently", async () => {
    const order: string[] = [];
    const tools = [
      makeTool("a", {
        isReadOnly: true,
        execute: async () => { order.push("a-start"); await new Promise(r => setTimeout(r, 20)); order.push("a-end"); return "a"; },
      }),
      makeTool("b", {
        isReadOnly: true,
        execute: async () => { order.push("b-start"); order.push("b-end"); return "b"; },
      }),
    ];
    const calls = [
      { id: "1", name: "a", arguments: "{}" },
      { id: "2", name: "b", arguments: "{}" },
    ];
    const results = await runToolBatch(tools, calls);
    expect(results).toHaveLength(2);
    // b should start before a finishes (concurrent)
    expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("a-end"));
  });

  it("runs write tools serially", async () => {
    const order: string[] = [];
    const tools = [
      makeTool("w1", {
        isReadOnly: false,
        execute: async () => { order.push("w1-start"); await new Promise(r => setTimeout(r, 10)); order.push("w1-end"); return "w1"; },
      }),
      makeTool("w2", {
        isReadOnly: false,
        execute: async () => { order.push("w2-start"); order.push("w2-end"); return "w2"; },
      }),
    ];
    const calls = [
      { id: "1", name: "w1", arguments: "{}" },
      { id: "2", name: "w2", arguments: "{}" },
    ];
    await runToolBatch(tools, calls);
    // w2 should start after w1 finishes (serial)
    expect(order).toEqual(["w1-start", "w1-end", "w2-start", "w2-end"]);
  });

  it("catches tool execution errors", async () => {
    const tools = [makeTool("boom", { execute: async () => { throw new Error("kaboom"); } })];
    const results = await runToolBatch(tools, [{ id: "1", name: "boom", arguments: "{}" }]);
    expect(results[0].isError).toBe(true);
    expect(results[0].output).toContain("Tool execution error");
  });

  it("passes arguments to tool", async () => {
    const tools = [makeTool("greet", {
      execute: async (input) => `Hello ${input.name}`,
    })];
    const results = await runToolBatch(tools, [{ id: "1", name: "greet", arguments: '{"name":"World"}' }]);
    expect(results[0].output).toBe("Hello World");
  });
});
