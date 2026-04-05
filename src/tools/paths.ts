import fs from "node:fs";
import path from "node:path";
import { expandTilde } from "../utils/paths.js";

/**
 * Create path resolution helpers scoped to a specific workspace directory.
 * Each agent gets its own resolver — avoids the multi-agent bug where a
 * shared global workspaceRoot would be overwritten by the last agent.
 */
export interface PathResolver {
  resolveFilePath: (filePath: string) => string;
  /** Resolve symlinks and verify the real path is inside the workspace. Returns error string or null. */
  validateWritePath: (filePath: string) => string | null;
  workspaceRoot: string;
}

export function createPathResolver(workspaceDir: string): PathResolver {
  const workspaceRoot = workspaceDir;
  const resolvedWorkspace = path.resolve(workspaceRoot);

  function resolveFilePath(filePath: string): string {
    if (filePath.startsWith("~/")) return path.resolve(expandTilde(filePath));
    if (path.isAbsolute(filePath)) return path.resolve(filePath);
    return path.resolve(workspaceRoot, filePath);
  }

  /**
   * Validate that a resolved path is safe for writing: resolve symlinks on
   * the existing portion of the path and ensure it stays within the workspace.
   * Returns an error message string, or null if safe.
   */
  function validateWritePath(filePath: string): string | null {
    // First check: syntactic prefix (handles non-existent paths)
    if (!filePath.startsWith(resolvedWorkspace + path.sep) && filePath !== resolvedWorkspace) {
      return `Path "${filePath}" is outside the workspace (${resolvedWorkspace}).`;
    }

    // Second check: resolve symlinks on the nearest existing ancestor
    // to catch symlink-based escapes (e.g. workspace/link -> /etc)
    let check = filePath;
    while (check !== resolvedWorkspace) {
      try {
        const real = fs.realpathSync(check);
        if (!real.startsWith(resolvedWorkspace + path.sep) && real !== resolvedWorkspace) {
          return `Path "${filePath}" resolves outside the workspace via symlink (real: ${real}).`;
        }
        return null; // existing ancestor is inside workspace — safe
      } catch {
        // Path doesn't exist yet — check parent
        const parent = path.dirname(check);
        if (parent === check) break; // reached root
        check = parent;
      }
    }

    return null; // reached workspace root — safe
  }

  return { resolveFilePath, validateWritePath, workspaceRoot };
}
