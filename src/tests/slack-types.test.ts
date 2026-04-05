import { describe, it, expect } from "vitest";
import { fileExtension } from "../utils/slack-types.js";

describe("fileExtension", () => {
  it("uses filetype when available", () => {
    expect(fileExtension({ filetype: "PNG" })).toBe("png");
  });

  it("falls back to name extension", () => {
    expect(fileExtension({ name: "report.pdf" })).toBe("pdf");
  });

  it("returns empty string when no info", () => {
    expect(fileExtension({})).toBe("");
  });

  it("prefers filetype over name", () => {
    expect(fileExtension({ filetype: "ts", name: "file.js" })).toBe("ts");
  });

  it("handles name without extension", () => {
    expect(fileExtension({ name: "Makefile" })).toBe("makefile");
  });
});
