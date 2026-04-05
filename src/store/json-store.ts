import { errMsg, isFileNotFound } from "../utils/errors.js";
import { atomicWriteJson, readJsonFile } from "../utils/json-file.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("store");

// Per-file mutex to prevent concurrent read-modify-write races.
// Node is single-threaded but async operations can interleave.
const locks = new Map<string, Promise<void>>();

const LOCK_WARN_MS = 5_000; // Warn if waiting for lock longer than 5s

/** Acquire a per-file lock, execute fn, then release. */
export async function withStoreLock<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(storePath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  locks.set(storePath, next);
  try {
    const waitStart = Date.now();
    await prev;
    const waitMs = Date.now() - waitStart;
    if (waitMs > LOCK_WARN_MS) {
      log.warn(`Store lock for ${storePath} waited ${(waitMs / 1000).toFixed(1)}s — possible contention`);
    }
    return await fn();
  } finally {
    release();
  }
}

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
    // File exists but has unexpected shape — warn and start fresh
    if (parsed) log.warn(`Unexpected store format in ${storePath}, starting fresh`);
    return EMPTY_STORE<T>();
  } catch (err) {
    // ENOENT is expected on first run — only warn on real errors (corruption, permission)
    if (!isFileNotFound(err)) {
      log.warn(`Failed to load ${storePath}:`, errMsg(err));
    }
    return EMPTY_STORE<T>();
  }
}

export async function saveStore<T>(storePath: string, store: StoreFile<T>): Promise<void> {
  await atomicWriteJson(storePath, store);
}
