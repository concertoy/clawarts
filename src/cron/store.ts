import fs from "node:fs";
import path from "node:path";
import type { CronStoreFile } from "./types.js";

/**
 * Load cron store from disk. Returns empty store if file doesn't exist.
 * Ported from openclaw src/cron/store.ts.
 */
export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.jobs)) {
      return parsed as CronStoreFile;
    }
    return { version: 1, jobs: [] };
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    console.warn(`[cron] Failed to load store at ${storePath}:`, err instanceof Error ? err.message : err);
    return { version: 1, jobs: [] };
  }
}

/**
 * Atomic save: write to temp file then rename (POSIX atomic).
 */
export async function saveCronStore(storePath: string, store: CronStoreFile): Promise<void> {
  const dir = path.dirname(storePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = storePath + `.tmp.${process.pid}`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
    await fs.promises.rename(tmp, storePath);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}
