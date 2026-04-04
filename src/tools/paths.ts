import os from "node:os";
import path from "node:path";

/**
 * Create path resolution helpers scoped to a specific workspace directory.
 * Each agent gets its own resolver — avoids the multi-agent bug where a
 * shared global workspaceRoot would be overwritten by the last agent.
 */
export function createPathResolver(workspaceDir: string) {
  const workspaceRoot = workspaceDir;

  function resolveFilePath(filePath: string): string {
    if (filePath.startsWith("~/")) {
      return path.resolve(path.join(os.homedir(), filePath.slice(2)));
    }
    if (path.isAbsolute(filePath)) return path.resolve(filePath);
    return path.resolve(workspaceRoot, filePath);
  }

  return { resolveFilePath, workspaceRoot };
}
