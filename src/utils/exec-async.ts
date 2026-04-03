import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const MAX_BUFFER = 1024 * 1024; // 1MB

/**
 * Async shell command execution using child_process.spawn.
 * Replaces execSync with non-blocking execution + AbortController timeout.
 * Ported from claude-code's Shell.ts pattern.
 */
export function execAsync(
  command: string,
  options: {
    cwd?: string;
    timeout?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ExecResult> {
  const { cwd, timeout = 30_000, signal } = options;

  return new Promise((resolve, reject) => {
    const ac = new AbortController();

    // Combine external signal with our timeout signal
    if (signal) {
      signal.addEventListener("abort", () => ac.abort(signal.reason), { once: true });
    }

    const timer = setTimeout(() => {
      ac.abort(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    const child = spawn("sh", ["-c", command], {
      cwd,
      signal: ac.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!stdoutTruncated) {
        stdout += chunk.toString();
        if (stdout.length > MAX_BUFFER) {
          stdout = stdout.slice(0, MAX_BUFFER);
          stdoutTruncated = true;
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (!stderrTruncated) {
        stderr += chunk.toString();
        if (stderr.length > MAX_BUFFER) {
          stderr = stderr.slice(0, MAX_BUFFER);
          stderrTruncated = true;
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (ac.signal.aborted) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: null });
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const suffix = stdoutTruncated || stderrTruncated ? "\n[Output truncated]" : "";
      resolve({
        stdout: stdout.trim() + (stdoutTruncated ? suffix : ""),
        stderr: stderr.trim() + (stderrTruncated ? suffix : ""),
        exitCode: code,
      });
    });
  });
}
