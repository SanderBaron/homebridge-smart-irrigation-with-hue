/**
 * Minimal time-to-live cache for a single computed value.
 *
 * Used by the platform to memoise the aggregated weather-snapshot list across
 * blocking-engine calls so we don't hammer the upstream APIs. The TTL is
 * driven by the `weather.cacheMinutes` config field (default 10).
 *
 * Generic over the cached value's type. The cache holds at most one entry —
 * if you need keyed caching, instantiate one TtlCache per key.
 */
export class TtlCache<T> {
  private ttlMs: number;
  private entry: { value: T; expiresAt: number } | undefined;
  private readonly nowFn: () => number;

  public constructor(ttlMs: number, nowFn: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.nowFn = nowFn;
  }

  /**
   * Return the cached value if it is still fresh; otherwise compute, store,
   * and return a new one. Concurrent callers that arrive while a compute is
   * in flight share the in-flight promise instead of triggering parallel
   * upstream requests.
   */
  public async getOrCompute(compute: () => Promise<T>): Promise<T> {
    const now = this.nowFn();
    if (this.entry !== undefined && this.entry.expiresAt > now) {
      return this.entry.value;
    }
    const value = await compute();
    this.entry = { value, expiresAt: this.nowFn() + this.ttlMs };
    return value;
  }

  /** Drop the cached value so the next call re-computes. */
  public invalidate(): void {
    this.entry = undefined;
  }

  /**
   * Seed the cache with a known value (e.g. restored from persistent state).
   * The TTL is reset from the current clock — useful for stale state that you
   * want to use briefly but soon refresh.
   */
  public set(value: T): void {
    this.entry = { value, expiresAt: this.nowFn() + this.ttlMs };
  }

  /** Update the TTL window; takes effect on the next compute. */
  public setTtl(ttlMs: number): void {
    this.ttlMs = ttlMs;
  }

  /** Inspect the cached value without triggering a compute. Returns undefined when expired or empty. */
  public peek(): T | undefined {
    if (this.entry === undefined) {
      return undefined;
    }
    if (this.entry.expiresAt <= this.nowFn()) {
      return undefined;
    }
    return this.entry.value;
  }
}
