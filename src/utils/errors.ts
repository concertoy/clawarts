/**
 * Extract a human-readable message from an unknown error value.
 */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Check if an error is an ENOENT (file not found) filesystem error.
 * Replaces the repeated `err instanceof Error && "code" in err && ... === "ENOENT"` pattern.
 */
export function isFileNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** Check if an error is an abort/cancellation error. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"));
}
