import { describe, expect, it, vi } from 'vitest';
import { cacheAnnotation } from '../src/cache-annotation';
import { createCacheMiddleware } from '../src/cache-middleware';
import type { CachedEntry, CacheStore } from '../src/cache-store';
import { makeCtx, makeExec, runMiss, spyStore } from './middleware-fixtures';

describe('createCacheMiddleware — invalidate', () => {
  it('deletes each key from the store', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });

    await mw.invalidate({ keys: ['user-1', 'user-2'] });

    expect(store.deleteSpy.mock.calls).toEqual([['user-1'], ['user-2']]);
    expect(store.deleteByTagSpy).not.toHaveBeenCalled();
  });

  it('deletes by tag with one store call carrying every tag', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });

    await mw.invalidate({ tags: ['users', 'posts'] });

    expect(store.deleteByTagSpy.mock.calls).toEqual([[['users', 'posts']]]);
    expect(store.deleteSpy).not.toHaveBeenCalled();
  });

  it('deletes by keys and by tags when given both', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });

    await mw.invalidate({ keys: ['user-1'], tags: ['users', 'posts'] });

    expect(store.deleteSpy.mock.calls).toEqual([['user-1']]);
    expect(store.deleteByTagSpy.mock.calls).toEqual([[['users', 'posts']]]);
  });

  it('removes a cached entry so the next read misses', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const exec = makeExec('select 1', {
      cache: cacheAnnotation({ ttl: 60_000, key: 'user-1', tags: ['users'] }),
    });
    const ctx = makeCtx();
    await runMiss(mw, exec, ctx, [{ id: 1 }]);
    expect(await mw.interceptQuery?.(exec, ctx)).toBeDefined();

    await mw.invalidate({ tags: ['users'] });

    expect(await mw.interceptQuery?.(exec, ctx)).toBeUndefined();
  });

  it('calls the store methods with the store as this', async () => {
    class MapStore implements CacheStore {
      readonly entries = new Map<string, CachedEntry>();
      async get(key: string) {
        return this.entries.get(key);
      }
      async set(key: string, entry: CachedEntry) {
        this.entries.set(key, entry);
      }
      async delete(key: string) {
        this.entries.delete(key);
      }
      async deleteByTag(tags: readonly string[]) {
        for (const [key, entry] of this.entries) {
          if (entry.tags?.some((tag) => tags.includes(tag))) {
            this.entries.delete(key);
          }
        }
      }
    }
    const store = new MapStore();
    store.entries.set('user-1', { rows: [], storedAt: 0 });
    store.entries.set('user-2', { rows: [], storedAt: 0, tags: ['users'] });
    store.entries.set('post-1', { rows: [], storedAt: 0, tags: ['posts'] });
    const mw = createCacheMiddleware({ store });

    await mw.invalidate({ keys: ['user-1'], tags: ['users'] });

    expect([...store.entries.keys()]).toEqual(['post-1']);
  });

  it('does not call the store when keys and tags are missing', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });

    await mw.invalidate({});

    expect(store.deleteSpy).not.toHaveBeenCalled();
    expect(store.deleteByTagSpy).not.toHaveBeenCalled();
  });

  it('does not call the store when keys and tags are empty', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });

    await mw.invalidate({ keys: [], tags: [] });

    expect(store.deleteSpy).not.toHaveBeenCalled();
    expect(store.deleteByTagSpy).not.toHaveBeenCalled();
  });

  describe('against a store that cannot delete', () => {
    it('refuses keys when the store has no delete', async () => {
      const store = spyStore();
      const mw = createCacheMiddleware({
        store: { get: store.get, set: store.set, deleteByTag: store.deleteByTag },
      });

      await expect(mw.invalidate({ keys: ['user-1'] })).rejects.toMatchObject({
        code: 'RUNTIME.CACHE_STORE_CANNOT_INVALIDATE',
        meta: { missingMethod: 'delete' },
      });
    });

    it('refuses tags when the store has no deleteByTag', async () => {
      const store = spyStore();
      const mw = createCacheMiddleware({
        store: { get: store.get, set: store.set, delete: store.delete },
      });

      await expect(mw.invalidate({ tags: ['users'] })).rejects.toMatchObject({
        code: 'RUNTIME.CACHE_STORE_CANNOT_INVALIDATE',
        meta: { missingMethod: 'deleteByTag' },
      });
    });

    it('deletes nothing when one of the two methods is missing', async () => {
      const store = spyStore();
      const mw = createCacheMiddleware({
        store: { get: store.get, set: store.set, delete: store.delete },
      });

      await expect(mw.invalidate({ keys: ['user-1'], tags: ['users'] })).rejects.toMatchObject({
        code: 'RUNTIME.CACHE_STORE_CANNOT_INVALIDATE',
        meta: { missingMethod: 'deleteByTag' },
      });
      expect(store.deleteSpy).not.toHaveBeenCalled();
    });

    it('deletes no tags when the store has no delete', async () => {
      const store = spyStore();
      const mw = createCacheMiddleware({
        store: { get: store.get, set: store.set, deleteByTag: store.deleteByTag },
      });

      await expect(mw.invalidate({ keys: ['user-1'], tags: ['users'] })).rejects.toMatchObject({
        code: 'RUNTIME.CACHE_STORE_CANNOT_INVALIDATE',
        meta: { missingMethod: 'delete' },
      });
      expect(store.deleteByTagSpy).not.toHaveBeenCalled();
    });

    it('lets an in-flight miss store its rows after a refused invalidate', async () => {
      const store = spyStore();
      const mw = createCacheMiddleware({
        store: { get: store.get, set: store.set, delete: store.delete },
      });
      const exec = makeExec('select 1', { cache: cacheAnnotation({ ttl: 60_000 }) });
      const ctx = makeCtx();

      await mw.interceptQuery?.(exec, ctx);
      await expect(mw.invalidate({ tags: ['users'] })).rejects.toMatchObject({
        code: 'RUNTIME.CACHE_STORE_CANNOT_INVALIDATE',
      });
      await mw.afterQuery?.(
        exec,
        { rowCount: 0, latencyMs: 0, completed: true, source: 'driver' },
        ctx,
      );

      expect(store.setSpy).toHaveBeenCalledTimes(1);
    });

    it('accepts an empty target', async () => {
      const store: CacheStore = spyStore();
      const mw = createCacheMiddleware({ store: { get: store.get, set: store.set } });

      await expect(mw.invalidate({ keys: [], tags: [] })).resolves.toBeUndefined();
    });
  });
});

describe('createCacheMiddleware — reads overlapping invalidate', () => {
  it('does not store rows from a miss that an invalidate overlapped', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const exec = makeExec('select 1', { cache: cacheAnnotation({ ttl: 60_000 }) });
    const debug = vi.fn();
    const ctx = makeCtx({
      log: { info: () => {}, warn: () => {}, error: () => {}, debug },
    });

    await mw.interceptQuery?.(exec, ctx);
    await mw.onRow?.({ id: 1 }, exec, ctx);
    await mw.invalidate({ tags: ['users'] });
    await mw.afterQuery?.(
      exec,
      { rowCount: 1, latencyMs: 0, completed: true, source: 'driver' },
      ctx,
    );

    expect(store.setSpy).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith({
      event: 'middleware.cache.store-skipped',
      middleware: 'cache',
      key: 'key:select 1',
    });
  });

  it('stores rows from a miss that started after an invalidate', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const exec = makeExec('select 1', { cache: cacheAnnotation({ ttl: 60_000 }) });
    const ctx = makeCtx();

    await mw.invalidate({ tags: ['users'] });
    await runMiss(mw, exec, ctx, [{ id: 1 }]);

    expect(store.setSpy).toHaveBeenCalledTimes(1);
  });

  it('stores rows from a miss when an empty invalidate ran during it', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const exec = makeExec('select 1', { cache: cacheAnnotation({ ttl: 60_000 }) });
    const ctx = makeCtx();

    await mw.interceptQuery?.(exec, ctx);
    await mw.invalidate({});
    await mw.afterQuery?.(
      exec,
      { rowCount: 0, latencyMs: 0, completed: true, source: 'driver' },
      ctx,
    );

    expect(store.setSpy).toHaveBeenCalledTimes(1);
  });
});
