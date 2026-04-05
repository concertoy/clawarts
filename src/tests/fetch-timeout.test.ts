import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";

// Spin up a local HTTP server for deterministic testing (no network dependency)
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200);
      res.end("hello");
    } else if (req.url === "/slow") {
      // Never respond — simulates a hang
      // (server closes on afterAll which cleans up)
    } else if (req.url === "/echo-headers") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.headers));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
});

describe("fetchWithTimeout", () => {
  it("fetches successfully", async () => {
    const resp = await fetchWithTimeout(`${baseUrl}/ok`);
    expect(resp.ok).toBe(true);
    expect(await resp.text()).toBe("hello");
  });

  it("aborts on timeout", async () => {
    await expect(
      fetchWithTimeout(`${baseUrl}/slow`, { timeoutMs: 100 }),
    ).rejects.toThrow();
  });

  it("passes custom headers", async () => {
    const resp = await fetchWithTimeout(`${baseUrl}/echo-headers`, {
      headers: { "X-Test": "hello" },
    });
    const headers = await resp.json();
    expect(headers["x-test"]).toBe("hello");
  });
});
