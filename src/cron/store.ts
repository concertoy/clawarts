import { errMsg } from "../utils/errors.js";
import { atomicWriteJson, readJsonFile } from "../utils/json-file.js";
import type { CronStoreFile } from "./types.js";

const EMPTY_STORE: CronStoreFile = { version: 1, jobs: [] };

/**
 * Load cron store from disk. Returns empty store if file doesn't exist.
 */
export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  try {
    const parsed = await readJsonFile<CronStoreFile>(storePath);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.jobs)) {
      return parsed;
    }
    return { ...EMPTY_STORE };
  } catch (err) {
    console.warn(`[cron] Failed to load store at ${storePath}:`, errMsg(err));
    return { ...EMPTY_STORE };
  }
}

export async function saveCronStore(storePath: string, store: CronStoreFile): Promise<void> {
  await atomicWriteJson(storePath, store);
}
