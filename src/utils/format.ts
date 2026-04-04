/**
 * Human-readable formatting utilities.
 * formatTokenCount ported from openclaw's usage-format.ts.
 */

/** Format a token count for display: 1200 → "1.2k", 2500000 → "2.5m". */
export function formatTokenCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "0";
  const safe = Math.max(0, value);
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}m`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(safe >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(safe));
}

/** Format a USD cost for display: 1.5 → "$1.50", 0.003 → "$0.0030". */
export function formatUsd(value: number): string {
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}
