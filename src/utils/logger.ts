/**
 * Structured logger with levels.
 * Controlled via LOG_LEVEL env var: debug, info, warn, error.
 * Default: info. Each logger instance carries a prefix (usually agent ID).
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const globalLevel: Level = (() => {
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return env in LEVELS ? (env as Level) : "info";
})();

export class Logger {
  constructor(private readonly prefix: string) {}

  debug(...args: unknown[]): void {
    if (LEVELS[globalLevel] <= LEVELS.debug) {
      console.debug(`[${this.prefix}]`, ...args);
    }
  }

  info(...args: unknown[]): void {
    if (LEVELS[globalLevel] <= LEVELS.info) {
      console.log(`[${this.prefix}]`, ...args);
    }
  }

  warn(...args: unknown[]): void {
    if (LEVELS[globalLevel] <= LEVELS.warn) {
      console.warn(`[${this.prefix}]`, ...args);
    }
  }

  error(...args: unknown[]): void {
    console.error(`[${this.prefix}]`, ...args);
  }

  /** Create a child logger with a sub-prefix. */
  child(sub: string): Logger {
    return new Logger(`${this.prefix}:${sub}`);
  }
}

/** Create a logger for a given component/agent. */
export function createLogger(prefix: string): Logger {
  return new Logger(prefix);
}
