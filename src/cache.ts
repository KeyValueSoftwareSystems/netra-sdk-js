/**
 * In-memory TTL cache for SDK read API responses.
 */

export class TTLCache<T = unknown> {
  private store = new Map<string, { value: T; expiresAt: number }>();
  private defaultTtl: number;

  constructor(defaultTtl = 60) {
    this.defaultTtl = defaultTtl;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (performance.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttl?: number): void {
    const ttlMs = (ttl ?? this.defaultTtl) * 1000;
    this.store.set(key, { value, expiresAt: performance.now() + ttlMs });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}
