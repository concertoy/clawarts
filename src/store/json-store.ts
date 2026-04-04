import { errMsg } from "../utils/errors.js";
import { atomicWriteJson, readJsonFile } from "../utils/json-file.js";

/**
 * Generic JSON file store. Each store file holds { version, items: T[] }.
 */

export interface StoreFile<T> {
  version: number;
  items: T[];
}

const EMPTY_STORE = <T>(): StoreFile<T> => ({ version: 1, items: [] });

export async function loadStore<T>(storePath: string): Promise<StoreFile<T>> {
  try {
    const parsed = await readJsonFile<StoreFile<T>>(storePath);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.items)) {
      return parsed;
    }
    return EMPTY_STORE<T>();
  } catch (err) {
    console.warn(`[store] Failed to load ${storePath}:`, errMsg(err));
    return EMPTY_STORE<T>();
  }
}

export async function saveStore<T>(storePath: string, store: StoreFile<T>): Promise<void> {
  await atomicWriteJson(storePath, store);
}
