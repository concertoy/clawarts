/**
 * JSON.stringify that handles BigInt, Error, Function, Uint8Array, and
 * circular references without throwing. Returns null on failure.
 * Ported from openclaw's safe-json.ts.
 */
export function safeJsonStringify(value: unknown): string | null {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "function") return "[Function]";
      if (val instanceof Error) return { name: val.name, message: val.message };
      if (val instanceof Uint8Array) return `[Uint8Array ${val.length} bytes]`;
      // Circular reference detection
      if (val !== null && typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    });
  } catch {
    return null;
  }
}
