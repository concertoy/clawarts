/**
 * A Map with a maximum size. When full, evicts the oldest entry (FIFO)
 * on insert. Replaces the repeated `map.delete(map.keys().next().value!)`
 * pattern scattered across caches.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly maxSize: number) {
    super();
  }

  override set(key: K, value: V): this {
    // If updating an existing key, delete first so it moves to end (most recent)
    if (this.has(key)) this.delete(key);
    // Evict oldest entries if at capacity
    while (this.size >= this.maxSize) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
      else break;
    }
    return super.set(key, value);
  }
}
