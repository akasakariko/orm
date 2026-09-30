import { expectTypeOf, test } from 'vitest';
import type { CachedEntry, CacheStore } from '../src/exports/index';
import * as exported from '../src/exports/index';

const cache = exported.createCacheMiddleware();

test('invalidate accepts keys, meta, both, or neither', () => {
  expectTypeOf(cache.invalidate({ keys: ['user-1'] })).toEqualTypeOf<Promise<void>>();
  expectTypeOf(cache.invalidate({ meta: { tags: ['users'] } })).toEqualTypeOf<Promise<void>>();
  expectTypeOf(cache.invalidate({ keys: ['user-1'], meta: 'users' })).toEqualTypeOf<
    Promise<void>
  >();
  expectTypeOf(cache.invalidate({})).toEqualTypeOf<Promise<void>>();
});

test('invalidate rejects other shapes', () => {
  // @ts-expect-error - tags are not an invalidation target; put them in meta
  cache.invalidate({ tags: ['users'] });

  // @ts-expect-error - a function is not an invalidation target
  cache.invalidate(async () => {});
});

test('createCacheMiddleware accepts only store and deriveKey', () => {
  exported.createCacheMiddleware({ store: exported.createInMemoryCacheStore() });

  // @ts-expect-error - maxEntries moved to createInMemoryCacheStore
  exported.createCacheMiddleware({ maxEntries: 10 });

  // @ts-expect-error - lifetime is the store's policy
  exported.createCacheMiddleware({ defaultTtlMs: 1_000 });

  // @ts-expect-error - clock moved to createInMemoryCacheStore
  exported.createCacheMiddleware({ clock: () => 0 });
});

test('createInMemoryCacheStore returns a CacheStore', () => {
  expectTypeOf(
    exported.createInMemoryCacheStore({
      maxEntries: 10,
      ttlMs: Number.POSITIVE_INFINITY,
      clock: Date.now,
    }),
  ).toEqualTypeOf<CacheStore>();
  expectTypeOf<CachedEntry>().toEqualTypeOf<{
    readonly rows: readonly Record<string, unknown>[];
  }>();
});

test('an old positional store is a type error', () => {
  const positional = {
    get: async (_key: string): Promise<CachedEntry | undefined> => undefined,
    set: async (_key: string, _entry: CachedEntry, _ttlMs: number) => {},
    unset: async (_key: string) => {},
  };

  // @ts-expect-error - set and unset take one object argument
  const store: CacheStore = positional;
  void store;
});

test('a store without unset is a type error', () => {
  const noUnset = {
    get: async (_key: string): Promise<CachedEntry | undefined> => undefined,
    set: async (_target: Parameters<CacheStore['set']>[0]) => {},
  };

  // @ts-expect-error - unset is required
  const store: CacheStore = noUnset;
  void store;
});

test('the package exports deriveKeyFromContentHash', () => {
  expectTypeOf(exported.deriveKeyFromContentHash).toBeFunction();
});

test('deriveKey composes with deriveKeyFromContentHash', () => {
  exported.createCacheMiddleware({
    deriveKey: async (exec, ctx) => `users:${await exported.deriveKeyFromContentHash(exec, ctx)}`,
  });
});
