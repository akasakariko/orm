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
 * - `unset` removes every entry named in `keys` and every entry that matches `meta`. `keys` is
 *   `undefined` or non-empty. A store that cannot act on a `meta` it is given must throw rather
 *   than ignore it. An `unset` by key must also drop that key from any `meta` index the store
 *   keeps.
 *
 * Lifetime and eviction are the store's policy. A `set` must be visible to any `unset` of the same
 * key issued after it resolves. The middleware's `unset` after a stale `set` may remove an entry a
 * later read stored under the same key; that costs one miss. `unset` must not run queries through
 * the runtime that uses the middleware.
 *
 * `TMeta` is the shape of `meta` the store understands. The middleware does not check that a read
 * annotation's `meta` has this shape; see `cacheAnnotation`.
 */
export interface CacheStore<TMeta = unknown> {
  get(key: string): Promise<CachedEntry | undefined>;
  set(target: {
    readonly key: string;
    readonly meta: TMeta | undefined;
    readonly entry: CachedEntry;
  }): Promise<void>;
  unset(target: {
    readonly keys: readonly string[] | undefined;
    readonly meta: TMeta | undefined;
  }): Promise<void>;
}

/**
 * Options for `createInMemoryCacheStore`.
 *
 * - `maxEntries` — the most entries kept, a positive integer; the least recently used is evicted
 *   first. Default 1000.
 * - `ttlMs` — how long an entry lives after its `set`, a positive number of milliseconds.
 *   `Infinity` never expires. Default 60 000.
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

function invalidOption(argument: 'maxEntries' | 'ttlMs', received: number, expected: string) {
  return structuredError(
    'RUNTIME.ARGUMENT_INVALID',
    `createInMemoryCacheStore: ${argument} must be ${expected}`,
    {
      fix: `Pass ${argument} as ${expected}, or leave it unset for the default.`,
      meta: { helper: 'createInMemoryCacheStore', argument, received },
    },
  );
}

/**
 * The default cache store: a least-recently-used map with one lifetime for every entry, local to
 * the process. It ignores `meta` in `set`, and its `unset` rejects any `meta`, including `null`.
 * It throws `RUNTIME.ARGUMENT_INVALID` for a `maxEntries` or `ttlMs` outside the ranges above.
 */
export function createInMemoryCacheStore(options?: InMemoryCacheStoreOptions): CacheStore<unknown> {
  const maxEntries = options?.maxEntries ?? 1000;
  const ttlMs = options?.ttlMs ?? 60_000;
  const clock = options?.clock ?? Date.now;
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw invalidOption('maxEntries', maxEntries, 'a positive integer');
  }
  if (!(ttlMs > 0)) {
    throw invalidOption('ttlMs', ttlMs, 'a positive number of milliseconds, or Infinity');
  }
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
