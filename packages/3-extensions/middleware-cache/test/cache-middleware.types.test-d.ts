import { expectTypeOf, test } from 'vitest';
import type { InMemoryCacheStore } from '../src/exports/index';
import * as exported from '../src/exports/index';

const cache = exported.createCacheMiddleware();
const store = exported.createInMemoryCacheStore({ maxEntries: 10 });

test('invalidate accepts keys', () => {
  expectTypeOf(cache.invalidate({ keys: ['user-1'] })).toEqualTypeOf<Promise<void>>();
});

test('invalidate accepts a function that takes no argument', () => {
  expectTypeOf(
    cache.invalidate(() => store.deleteWhere((entry) => entry.attributes === 'users')),
  ).toEqualTypeOf<Promise<void>>();
});

test('invalidate rejects other shapes', () => {
  // @ts-expect-error - tags are not an invalidation target
  cache.invalidate({ tags: ['users'] });

  // @ts-expect-error - keys are required
  cache.invalidate({});

  // @ts-expect-error - the function receives no store
  cache.invalidate(async (s: InMemoryCacheStore) => s.deleteWhere(() => true));
});

test('createInMemoryCacheStore returns an InMemoryCacheStore with required delete', () => {
  expectTypeOf(store).toEqualTypeOf<InMemoryCacheStore>();
  expectTypeOf(store.delete).toEqualTypeOf<(key: string) => Promise<void>>();
  expectTypeOf<Parameters<InMemoryCacheStore['deleteWhere']>[0]>().toEqualTypeOf<
    (entry: { readonly key: string; readonly attributes: unknown }) => boolean
  >();
});

test('the package exports deriveKeyFromContentHash', () => {
  expectTypeOf(exported.deriveKeyFromContentHash).toBeFunction();
});

test('deriveKey composes with deriveKeyFromContentHash', () => {
  exported.createCacheMiddleware({
    deriveKey: async (exec, ctx) => `users:${await exported.deriveKeyFromContentHash(exec, ctx)}`,
  });
});
