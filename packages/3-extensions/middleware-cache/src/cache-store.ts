/**
 * A cached set of rows produced by a single execution.
 *
 * - `rows` are stored raw (undecoded). The SQL runtime's `decodeRow` pass
 *   wraps the orchestrator output, so intercepted rows go through the
 *   same codec decoding as driver rows on the way to the consumer. The
 *   cache stores wire-format values; decoding happens once per consumer
 *   read regardless of where the rows came from.
 * - `storedAt` is the clock value at the moment the entry was committed
 *   to the store. It is informational metadata for callers (debugging,
 *   telemetry) and is **not** used by the in-memory store itself for
 *   expiry — TTL is driven by the store's own clock plus the `ttlMs`
 *   passed to `set`. Custom stores may use it differently.
 * - `tags` label the entry so `deleteByTag` can remove it. An entry
 *   stored without tags has no `tags` property.
 */
export interface CachedEntry {
  readonly rows: readonly Record<string, unknown>[];
  readonly storedAt: number;
  readonly tags?: readonly string[];
}

/**
 * Pluggable cache backend used by the cache middleware.
 *
 * The default implementation is an in-memory LRU with TTL produced by
 * `createInMemoryCacheStore`. Users can supply Redis, Memcached, or any
 * other backend by implementing this interface.
 *
 * The interface is intentionally minimal:
 *
 * - `get` returns the entry if it exists and has not expired, or
 *   `undefined` otherwise. Implementations that gate on TTL should
 *   treat an expired entry as absent (return `undefined`) and may
 *   evict it as a side effect.
 * - `set` writes the entry under the key with an associated TTL in
 *   milliseconds. Implementations may evict other entries to make
 *   room (LRU, LFU, etc.) and may treat the operation as fire-and-
 *   forget at scale; the cache middleware does not rely on `set`
 *   completing before subsequent `get`s.
 * - `delete` (optional) removes the entry under the key, if any.
 * - `deleteByTag` (optional) removes every entry carrying at least one
 *   of the given tags.
 *
 * Stores that omit `delete` or `deleteByTag` cannot be invalidated by
 * key or by tag respectively.
 *
 * Both methods are async to leave the door open for I/O-backed stores
 * (Redis, S3, etc.). The default in-memory store completes
 * synchronously and wraps the result in `Promise.resolve` for type
 * conformance.
 */
export interface CacheStore {
  get(key: string): Promise<CachedEntry | undefined>;
  set(key: string, entry: CachedEntry, ttlMs: number): Promise<void>;
  delete?(key: string): Promise<void>;
  deleteByTag?(tags: readonly string[]): Promise<void>;
}

/**
 * Options accepted by `createInMemoryCacheStore`.
 *
 * - `maxEntries` — hard cap on the number of live entries. Once the cap
 *   is exceeded, the least recently used entry is evicted. Reads and
 *   writes both count as "uses" for ordering purposes.
 * - `clock` — injectable time source for TTL math. Defaults to
 *   `Date.now`. Tests inject a controlled clock to verify expiry without
 *   real-time waits.
 */
export interface InMemoryCacheStoreOptions {
  readonly maxEntries: number;
  readonly clock?: () => number;
}

interface StoredRecord {
  readonly entry: CachedEntry;
  readonly expiresAt: number;
}

/**
 * Default cache backend. An LRU with per-entry TTL, backed by a `Map`.
 *
 * Eviction policy:
 *
 * - On `set` of a fresh key whose insertion would push the live count
 *   above `maxEntries`, the least recently used entry is evicted.
 *   Setting an existing key updates the entry in place and refreshes its
 *   recency without changing the live count.
 * - On `get` of an existing key, recency is bumped (so the entry is no
 *   longer the LRU candidate).
 * - On `get` of an expired entry, the entry is removed from the map and
 *   `undefined` is returned. The slot becomes available for new writes
 *   without counting against `maxEntries`.
 *
 * `Map` insertion order is the LRU order: the first key is the LRU
 * candidate; the last key is the most recently used. Bumping recency is
 * a delete-then-set on the underlying map.
 *
 * Tags are indexed in a separate tag-to-keys map. A key leaves the
 * index whenever its entry leaves the store (delete, deleteByTag,
 * expiry, eviction, overwrite), so a tag never reaches a later entry
 * stored under the same key. The index does not count toward
 * `maxEntries`.
 *
 * The default store is **not** coherent across processes or replicas —
 * each process holds its own Map. Users who need a shared cache supply
 * their own `CacheStore` (Redis, Memcached, etc.).
 */
export function createInMemoryCacheStore(options: InMemoryCacheStoreOptions): Required<CacheStore> {
  const maxEntries = options.maxEntries;
  const clock = options.clock ?? Date.now;
  const map = new Map<string, StoredRecord>();
  const keysByTag = new Map<string, Set<string>>();

  function indexTags(key: string, tags: readonly string[]): void {
    for (const tag of tags) {
      const keys = keysByTag.get(tag);
      if (keys === undefined) {
        keysByTag.set(tag, new Set([key]));
      } else {
        keys.add(key);
      }
    }
  }

  function remove(key: string): void {
    const record = map.get(key);
    if (record === undefined) {
      return;
    }
    map.delete(key);
    for (const tag of record.entry.tags ?? []) {
      const keys = keysByTag.get(tag);
      keys?.delete(key);
      if (keys?.size === 0) {
        keysByTag.delete(tag);
      }
    }
  }

  function get(key: string): Promise<CachedEntry | undefined> {
    const record = map.get(key);
    if (record === undefined) {
      return Promise.resolve(undefined);
    }
    if (clock() >= record.expiresAt) {
      remove(key);
      return Promise.resolve(undefined);
    }
    // Bump recency: re-insert at the end of the iteration order.
    map.delete(key);
    map.set(key, record);
    return Promise.resolve(record.entry);
  }

  function set(key: string, entry: CachedEntry, ttlMs: number): Promise<void> {
    const expiresAt = clock() + ttlMs;
    // Removing first ensures the new value lands at the end of the
    // iteration order (most recently used) and drops the old entry's tags.
    remove(key);
    map.set(key, { entry, expiresAt });
    indexTags(key, entry.tags ?? []);

    // Evict LRU entries until the live count is within bounds. The
    // iterator yields keys in insertion order; the first one is the
    // oldest (LRU).
    while (map.size > maxEntries) {
      const oldest = map.keys().next();
      if (oldest.done) {
        break;
      }
      remove(oldest.value);
    }

    return Promise.resolve();
  }

  function deleteKey(key: string): Promise<void> {
    remove(key);
    return Promise.resolve();
  }

  function deleteByTag(tags: readonly string[]): Promise<void> {
    for (const tag of tags) {
      for (const key of [...(keysByTag.get(tag) ?? [])]) {
        remove(key);
      }
    }
    return Promise.resolve();
  }

  return { get, set, delete: deleteKey, deleteByTag };
}
