import fs from "node:fs";

/** Lazy-loaded version string from package.json. */
let cached: string | null = null;

declare const CLAWARTS_VERSION: string | undefined;

export function getVersion(): string {
  if (cached !== null) return cached;
  // Build-time injected version (esbuild --define)
  if (typeof CLAWARTS_VERSION !== "undefined") {
    cached = CLAWARTS_VERSION;
    return cached;
  }
  try {
    const pkgPath = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    cached = pkg.version ?? "unknown";
  } catch {
    cached = "unknown";
  }
  return cached!;
}
