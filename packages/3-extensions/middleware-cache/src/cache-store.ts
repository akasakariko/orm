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
 * The store keeps a version per key, an integer it keeps even for a key that holds no entry. A
 * key never seen, or forgotten, has version 0. Only `unset` changes a version.
 *
 * - `get` returns the live entry under `key`, or `undefined`, and the key's current version.
 * - `set` stores `entry` under `key`. When `version` is a number, it stores only if the key's
 *   version is still that number, and returns whether it stored. When `version` is `undefined`,
 *   it stores unconditionally and returns `true`. The compare and the write must be atomic with
 *   respect to `unset`, for example one synchronous step in memory or one script on a server.
 *   `meta` is the read annotation's `meta`, or `undefined`, passed by reference. The store decides
 *   what it means, for example tags to index or a lifetime.
 * - `unset` removes every entry named in `keys` and every entry that matches `meta`, and
 *   increments the version of every key it removes or would remove, including keys that hold no
 *   entry. `keys` is `undefined` or non-empty. A store that cannot act on a `meta` it is given
 *   must throw rather than ignore it. An `unset` by key must also drop that key from any `meta`
 *   index the store keeps.
 *
 * Lifetime and eviction are the store's policy. A version that `unset` moved must be kept at least
 * as long as a read can take, so that a read that started before the `unset` cannot store. `unset`
 * must not run queries through the runtime that uses the middleware.
 *
 * `TMeta` is the shape of `meta` the store understands. The middleware does not check that a read
 * annotation's `meta` has this shape; see `cacheAnnotation`.
 */
export interface CacheStore<TMeta = unknown> {
  get(key: string): Promise<{ readonly entry: CachedEntry | undefined; readonly version: number }>;
  set(target: {
    readonly key: string;
    readonly meta: TMeta | undefined;
    readonly entry: CachedEntry;
    readonly version: number | undefined;
  }): Promise<boolean>;
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
 * - `ttlMs` — how long an entry lives after its `set`, and how long a key's version is kept after
 *   the `unset` that moved it, a positive number of milliseconds. `Infinity` never expires.
 *   Default 60 000.
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

interface VersionRecord {
  readonly version: number;
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
 * the process. A key's version is kept for `ttlMs` after the `unset` that moved it, so a key
 * invalidated and never stored again costs one number until then. It ignores `meta` in `set`, and
 * its `unset` rejects any `meta`, including `null`, before changing anything. It throws
 * `RUNTIME.ARGUMENT_INVALID` for a `maxEntries` or `ttlMs` outside the ranges above.
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
  const versions = new Map<string, VersionRecord>();

  function forgetExpiredVersions(): void {
    const now = clock();
    for (const [key, record] of versions) {
      if (now < record.expiresAt) {
        return;
      }
      versions.delete(key);
    }
  }

  function versionOf(key: string): number {
    forgetExpiredVersions();
    return versions.get(key)?.version ?? 0;
  }

  function liveEntry(key: string): CachedEntry | undefined {
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

  async function get(key: string) {
    return { entry: liveEntry(key), version: versionOf(key) };
  }

  async function set(target: {
    readonly key: string;
    readonly entry: CachedEntry;
    readonly version: number | undefined;
  }) {
    if (target.version !== undefined && target.version !== versionOf(target.key)) {
      return false;
    }
    records.delete(target.key);
    records.set(target.key, { entry: target.entry, expiresAt: clock() + ttlMs });
    for (const leastRecentlyUsed of records.keys()) {
      if (records.size <= maxEntries) {
        break;
      }
      records.delete(leastRecentlyUsed);
    }
    return true;
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
      const version = versionOf(key) + 1;
      versions.delete(key);
      versions.set(key, { version, expiresAt: clock() + ttlMs });
    }
  }

  return { get, set, unset };
}
