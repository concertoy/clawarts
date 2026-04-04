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
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { version: 1, items: [] };
    }
    console.warn(`[store] Failed to load ${storePath}:`, err);
    return { version: 1, items: [] };
  }
}

export async function saveStore<T>(storePath: string, store: StoreFile<T>): Promise<void> {
  const dir = path.dirname(storePath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
}
