import { expectTypeOf, test } from 'vitest';
import {
  type CacheAnnotationHandle,
  type CacheAnnotationOptions,
  type CachedEntry,
  type CacheMiddleware,
  type CacheStore,
  cacheAnnotation,
  createCacheMiddleware,
  createInMemoryCacheStore,
} from '../src/exports/index';

interface TagMeta {
  tags: string[];
}

class TagStore implements CacheStore<TagMeta> {
  async get(_target: {
    readonly key: string;
    readonly meta: TagMeta | undefined;
  }): Promise<{ readonly entry: CachedEntry | undefined; version: number }> {
    return { entry: undefined, version: 0 };
  }
  async set(_target: {
    readonly key: string;
    readonly meta: TagMeta | undefined;
    readonly entry: CachedEntry;
    readonly version: number | undefined;
  }): Promise<boolean> {
    return true;
  }
  async unset(_target: {
    readonly keys: readonly string[] | undefined;
    readonly meta: TagMeta | undefined;
  }): Promise<void> {}
}

test('createCacheMiddleware infers TMeta from the store', () => {
  const cache = createCacheMiddleware({ store: new TagStore() });

  expectTypeOf(cache).toEqualTypeOf<CacheMiddleware<TagMeta>>();
});

test('invalidate takes the store meta type', () => {
  const cache = createCacheMiddleware({ store: new TagStore() });

  cache.invalidate({ meta: { tags: ['x'] } });
  cache.invalidate({ keys: ['user-1'] });

  // @ts-expect-error - the store's meta has tags, not tag
  cache.invalidate({ meta: { tag: 'x' } });
});

test('cacheAnnotation takes a meta type argument', () => {
  cacheAnnotation<TagMeta>({ meta: { tags: ['x'] } });

  // @ts-expect-error - TagMeta has tags, not tag
  cacheAnnotation<TagMeta>({ meta: { tag: 'x' } });
});

test('a pre-typed wrapper keeps the annotation and the store in agreement', () => {
  const cached = (options: CacheAnnotationOptions<TagMeta>) => cacheAnnotation<TagMeta>(options);

  cached({ key: 'user-1', meta: { tags: ['users'] } });

  // @ts-expect-error - TagMeta has tags, not tag
  cached({ meta: { tag: 'x' } });
});

test('untyped calls default to unknown', () => {
  expectTypeOf(createInMemoryCacheStore()).toEqualTypeOf<CacheStore<unknown>>();
  expectTypeOf(createCacheMiddleware()).toEqualTypeOf<CacheMiddleware<unknown>>();
  expectTypeOf(createCacheMiddleware({ store: createInMemoryCacheStore() })).toEqualTypeOf<
    CacheMiddleware<unknown>
  >();
  expectTypeOf<CacheAnnotationOptions['meta']>().toEqualTypeOf<unknown>();
  createCacheMiddleware().invalidate({ meta: { anything: 1 } });
  cacheAnnotation({ meta: { anything: 1 } });
  expectTypeOf(cacheAnnotation.read).returns.toEqualTypeOf<CacheAnnotationOptions | undefined>();
});

test('cacheAnnotation is a CacheAnnotationHandle with readonly handle members', () => {
  expectTypeOf(cacheAnnotation).toEqualTypeOf<CacheAnnotationHandle>();

  // @ts-expect-error - namespace is readonly
  cacheAnnotation.namespace = 'other';

  // @ts-expect-error - read is readonly
  cacheAnnotation.read = () => undefined;
});
