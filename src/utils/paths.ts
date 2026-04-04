import os from "node:os";
import path from "node:path";

/** Expand leading `~/` to the user's home directory. */
export function expandTilde(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
