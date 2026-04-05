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

/** Format a duration in ms for display: 3600000 → "1.0h", 90000 → "1.5m", 5000 → "5.0s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms >= 86_400_000) return `${(ms / 86_400_000).toFixed(1)}d`;
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

/** Format a relative time for display: timestamp → "5m ago" or "never". */
export function formatTimeAgo(epochMs: number | undefined): string {
  if (!epochMs) return "never";
  const diffMs = Date.now() - epochMs;
  if (diffMs < 0) return "just now"; // future timestamps treated as "just now"
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${(mins / 60).toFixed(1)}h ago`;
  return `${(mins / 1440).toFixed(1)}d ago`;
}
