import path from "node:path";

export let workspaceRoot = "";

export function setWorkspaceRoot(dir: string): void {
  workspaceRoot = dir;
}

export function resolveFilePath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.resolve(path.join(process.env.HOME ?? "", filePath.slice(2)));
  }
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  return path.resolve(workspaceRoot, filePath);
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
