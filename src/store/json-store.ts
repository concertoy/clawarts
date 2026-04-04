import fs from "node:fs";
import path from "node:path";

/**
 * Generic JSON file store. Same pattern as src/cron/store.ts but typed.
 * Each store file holds { version, items: T[] }.
 */

export interface StoreFile<T> {
  version: number;
  items: T[];
}

export async function loadStore<T>(storePath: string): Promise<StoreFile<T>> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.items)) {
      return parsed as StoreFile<T>;
    }
    return { version: 1, items: [] };
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, items: [] };
    }
    console.warn(`[store] Failed to load ${storePath}:`, err instanceof Error ? err.message : err);
    return { version: 1, items: [] };
  }
}

/**
 * Atomic save: write to a temp file in the same directory, then rename.
 * rename() is atomic on POSIX — prevents corruption from crashes or concurrent writes.
 */
export async function saveStore<T>(storePath: string, store: StoreFile<T>): Promise<void> {
  const dir = path.dirname(storePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = storePath + `.tmp.${process.pid}`;
  await fs.promises.writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
  await fs.promises.rename(tmp, storePath);
}
