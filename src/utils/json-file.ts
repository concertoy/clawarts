import fs from "node:fs";
import path from "node:path";
import { isFileNotFound } from "./errors.js";

/**
 * Atomic JSON write: serialize to temp file then rename.
 * rename() is atomic on POSIX — prevents corruption from crashes or concurrent writes.
 * Ensures parent directory exists.
 */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = filePath + `.tmp.${process.pid}`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Read and parse a JSON file. Returns null if the file doesn't exist.
 * Throws on parse errors or other I/O errors.
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if (isFileNotFound(err)) {
      return null;
    }
    throw err;
  }
}
