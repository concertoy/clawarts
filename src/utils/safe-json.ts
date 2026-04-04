/**
 * JSON.stringify that handles BigInt, Error, Function, and Uint8Array
 * without throwing. Returns null on failure.
 * Ported from openclaw's safe-json.ts.
 */
export function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "function") return "[Function]";
      if (val instanceof Error) return { name: val.name, message: val.message };
      if (val instanceof Uint8Array) return `[Uint8Array ${val.length} bytes]`;
      return val;
    });
  } catch {
    return null;
  }
}
