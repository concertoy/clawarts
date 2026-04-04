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
    if (timer.unref) timer.unref();

    const child = spawn("sh", ["-c", command], {
      cwd,
      signal: ac.signal,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // Create process group so we can kill the entire tree on timeout
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
      // Kill the process group to prevent orphan children
      try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* already dead */ }
      if (ac.signal.aborted) {
        // Include timeout info in stderr so callers can detect it
        const reason = ac.signal.reason;
        const timeoutMsg = reason instanceof Error && reason.message.includes("timed out")
          ? `\n[TIMEOUT: ${reason.message}]` : "";
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() + timeoutMsg, exitCode: null });
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim() + (stdoutTruncated ? "\n[stdout truncated at 1MB]" : ""),
        stderr: stderr.trim() + (stderrTruncated ? "\n[stderr truncated at 1MB]" : ""),
        exitCode: code,
      });
    });
  });
}
