import fs from "node:fs";

/** Lazy-loaded version string from package.json. */
let cached: string | null = null;

export function getVersion(): string {
  if (cached !== null) return cached;
  try {
    const pkgPath = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    cached = pkg.version ?? "unknown";
  } catch {
    cached = "unknown";
  }
  return cached!;
}
