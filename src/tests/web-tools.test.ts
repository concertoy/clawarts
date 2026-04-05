import { describe, it, expect } from "vitest";
import { createWebTools, isInternalHost } from "../tools/web-tools.js";

const tools = createWebTools();
const webFetch = tools.find((t) => t.name === "web_fetch")!;

describe("isInternalHost", () => {
  it("blocks localhost variants", () => {
    expect(isInternalHost("localhost")).toBe(true);
    expect(isInternalHost("127.0.0.1")).toBe(true);
    expect(isInternalHost("::1")).toBe(true);
    expect(isInternalHost("0.0.0.0")).toBe(true);
  });

  it("blocks private IPv4 ranges", () => {
    expect(isInternalHost("10.0.0.1")).toBe(true);
    expect(isInternalHost("10.255.255.255")).toBe(true);
    expect(isInternalHost("172.16.0.1")).toBe(true);
    expect(isInternalHost("172.31.255.255")).toBe(true);
    expect(isInternalHost("192.168.1.1")).toBe(true);
    expect(isInternalHost("169.254.169.254")).toBe(true);
  });

  it("allows public IPs", () => {
    expect(isInternalHost("8.8.8.8")).toBe(false);
    expect(isInternalHost("172.32.0.1")).toBe(false);
    expect(isInternalHost("192.169.1.1")).toBe(false);
  });

  it("blocks .internal and .local domains", () => {
    expect(isInternalHost("metadata.google.internal")).toBe(true);
    expect(isInternalHost("my-service.local")).toBe(true);
  });

  it("allows public domains", () => {
    expect(isInternalHost("example.com")).toBe(false);
    expect(isInternalHost("api.github.com")).toBe(false);
  });
});

describe("web_fetch SSRF guard", () => {
  it("blocks localhost", async () => {
    const result = await webFetch.execute({ url: "http://localhost:8080/secret" });
    expect(result).toContain("internal");
  });

  it("blocks 127.0.0.1", async () => {
    const result = await webFetch.execute({ url: "http://127.0.0.1/admin" });
    expect(result).toContain("internal");
  });

  it("blocks cloud metadata endpoint", async () => {
    const result = await webFetch.execute({ url: "http://169.254.169.254/latest/meta-data/" });
    expect(result).toContain("internal");
  });

  it("blocks non-http protocols", async () => {
    const result = await webFetch.execute({ url: "file:///etc/passwd" });
    expect(result).toContain("Only http and https");
  });

  it("blocks .internal domains", async () => {
    const result = await webFetch.execute({ url: "http://metadata.google.internal/computeMetadata/v1/" });
    expect(result).toContain("internal");
  });

  it("blocks private IP ranges", async () => {
    const result = await webFetch.execute({ url: "http://10.0.0.1/admin" });
    expect(result).toContain("internal");
  });

  it("rejects invalid URLs", async () => {
    const result = await webFetch.execute({ url: "not a url" });
    expect(result).toContain("Invalid URL");
  });
});
