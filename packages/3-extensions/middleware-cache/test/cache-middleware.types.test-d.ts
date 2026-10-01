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

test('an old positional set is a type error', () => {
  const positionalSet = {
    get: async (_target: Parameters<CacheStore['get']>[0]) => ({ entry: undefined, version: 0 }),
    set: async (_key: string, _entry: CachedEntry, _ttlMs: number) => true,
    unset: async (_target: Parameters<CacheStore['unset']>[0]) => {},
  };

  // @ts-expect-error - set takes one object argument
  const store: CacheStore = positionalSet;
  void store;
});

test('an old positional unset(key) is a type error', () => {
  const positionalUnset = {
    get: async (_target: Parameters<CacheStore['get']>[0]) => ({ entry: undefined, version: 0 }),
    set: async (_target: Parameters<CacheStore['set']>[0]) => true,
    unset: async (_key: string) => {},
  };

  // @ts-expect-error - unset takes one object argument
  const store: CacheStore = positionalUnset;
  void store;
});

test('a store without unset is a type error', () => {
  const noUnset = {
    get: async (_target: Parameters<CacheStore['get']>[0]) => ({ entry: undefined, version: 0 }),
    set: async (_target: Parameters<CacheStore['set']>[0]) => true,
  };

  // @ts-expect-error - unset is required
  const store: CacheStore = noUnset;
  void store;
});

test('an old get(key: string) is a type error', () => {
  const positionalGet = {
    get: async (_key: string) => ({ entry: undefined, version: 0 }),
    set: async (_target: Parameters<CacheStore['set']>[0]) => true,
    unset: async (_target: Parameters<CacheStore['unset']>[0]) => {},
  };

  // @ts-expect-error - get takes { key, meta }
  const store: CacheStore = positionalGet;
  void store;
});

test('an old get returning the entry alone is a type error', () => {
  const oldGet = {
    get: async (_target: Parameters<CacheStore['get']>[0]): Promise<CachedEntry | undefined> =>
      undefined,
    set: async (_target: Parameters<CacheStore['set']>[0]) => true,
    unset: async (_target: Parameters<CacheStore['unset']>[0]) => {},
  };

  // @ts-expect-error - get returns { entry, version }
  const store: CacheStore = oldGet;
  void store;
});

test('an old set returning nothing is a type error', () => {
  const oldSet = {
    get: async (_target: Parameters<CacheStore['get']>[0]) => ({ entry: undefined, version: 0 }),
    set: async (_target: Parameters<CacheStore['set']>[0]) => {},
    unset: async (_target: Parameters<CacheStore['unset']>[0]) => {},
  };

  // @ts-expect-error - set returns whether it stored the entry
  const store: CacheStore = oldSet;
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
