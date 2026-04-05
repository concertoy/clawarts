/**
 * A BoundedMap with built-in TTL expiration.
 * Entries expire after `ttlMs` milliseconds and are lazily evicted on access.
 * A background sweep runs periodically (default 60s) to clean up expired entries.
 *
 * Replaces the manual sweepExpired() + expiresAt pattern in web-tools and slack dedup.
 */
import { BoundedMap } from "./bounded-map.js";

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TTLMap<K, V> {
  private readonly map: BoundedMap<K, Entry<V>>;
  private readonly ttlMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval> | null;
  private readonly now: () => number;

  constructor(opts: { maxSize: number; ttlMs: number; sweepIntervalMs?: number; now?: () => number }) {
    this.map = new BoundedMap(opts.maxSize);
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;

    const sweepMs = opts.sweepIntervalMs ?? 60_000;
    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
      if (this.sweepTimer.unref) this.sweepTimer.unref();
    } else {
      this.sweepTimer = null;
    }
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  /** Remove all expired entries. Runs automatically on the sweep interval. */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) this.map.delete(key);
    }
  }

  /** Stop the background sweep timer. Call when disposing. */
  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  clear(): void {
    this.map.clear();
  }
}
