import { structuredError } from '@internal/utils/structured-error';

/**
 * The rows one read produced, stored raw (undecoded). The SQL runtime decodes intercepted rows the
 * same way as driver rows, so a hit and a miss yield the same values to the consumer.
 */
export interface CachedEntry {
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * The backend the cache middleware reads from and writes to.
 *
 * - `get` returns the live entry under `key`, or `undefined`.
 * - `set` stores `entry` under `key`. `meta` is the read annotation's `meta`, or `undefined`,
 *   passed by reference. The store decides what it means, for example tags to index or a lifetime.
 * - `unset` removes the entries named by `keys`, the entries that match `meta`, or both. A store
 *   that cannot act on a `meta` it is given must throw rather than ignore it.
 *
 * Lifetime and eviction are the store's policy. A `set` must be visible to any `unset` of the same
 * key issued after it resolves. `unset` must not run queries through the runtime that uses the
 * middleware.
 */
export interface CacheStore {
  get(key: string): Promise<CachedEntry | undefined>;
  set(target: {
    readonly key: string;
    readonly meta: unknown;
    readonly entry: CachedEntry;
  }): Promise<void>;
  unset(target: {
    readonly keys: readonly string[] | undefined;
    readonly meta: unknown;
  }): Promise<void>;
}

/**
 * Options for `createInMemoryCacheStore`.
 *
 * - `maxEntries` — the most entries kept; the least recently used is evicted first. Default 1000.
 * - `ttlMs` — how long an entry lives after its `set`. `Infinity` never expires. Default 60 000.
 * - `clock` — the time source for expiry. Default `Date.now`.
 */
export interface InMemoryCacheStoreOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly clock?: () => number;
}

interface StoredRecord {
  readonly entry: CachedEntry;
  readonly expiresAt: number;
}

function metaUnsupported() {
  return structuredError(
    'RUNTIME.CACHE_STORE_META_UNSUPPORTED',
    'The in-memory cache store cannot remove entries by meta because it does not index meta',
    { fix: 'Invalidate by keys, or supply a CacheStore that indexes meta in set and unset.' },
  );
}

/**
 * The default cache store: a least-recently-used map with one lifetime for every entry, local to
 * the process. It ignores `meta` in `set`, and its `unset` rejects any `meta`, including `null`.
 */
export function createInMemoryCacheStore(options?: InMemoryCacheStoreOptions): CacheStore {
  const maxEntries = options?.maxEntries ?? 1000;
  const ttlMs = options?.ttlMs ?? 60_000;
  const clock = options?.clock ?? Date.now;
  const records = new Map<string, StoredRecord>();

  async function get(key: string): Promise<CachedEntry | undefined> {
    const record = records.get(key);
    if (record === undefined) {
      return undefined;
    }
    records.delete(key);
    if (clock() >= record.expiresAt) {
      return undefined;
    }
    records.set(key, record);
    return record.entry;
  }

  async function set(target: { readonly key: string; readonly entry: CachedEntry }) {
    records.delete(target.key);
    records.set(target.key, { entry: target.entry, expiresAt: clock() + ttlMs });
    for (const leastRecentlyUsed of records.keys()) {
      if (records.size <= maxEntries) {
        break;
      }
      records.delete(leastRecentlyUsed);
    }
  }

  async function unset(target: {
    readonly keys: readonly string[] | undefined;
    readonly meta: unknown;
  }) {
    if (target.meta !== undefined) {
      throw metaUnsupported();
    }
    for (const key of target.keys ?? []) {
      records.delete(key);
    }
  }

  return { get, set, unset };
}
