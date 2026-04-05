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

/** Check if an error is an abort/cancellation error (from AbortController). */
export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  // DOMException with ABORT_ERR code (used by fetch)
  if ("code" in err && (err as { code: number }).code === 20) return true;
  // Fallback: Node.js abort reason strings
  if (err.message === "This operation was aborted" || err.message === "The operation was aborted") return true;
  return false;
}
