import type { RuntimeMiddlewareContext } from '@internal/framework-components/runtime';
import { describe, expect, it, vi } from 'vitest';
import { cacheAnnotation } from '../src/cache-annotation';
import { type CacheMiddleware, createCacheMiddleware } from '../src/cache-middleware';
import type { CachedEntry, CacheStore } from '../src/cache-store';
import { type MockExec, makeCtx, makeExec, runMiss, spyStore } from './middleware-fixtures';

async function startMiss(mw: CacheMiddleware, ctx: RuntimeMiddlewareContext): Promise<MockExec> {
  const exec = makeExec('select 1', { cache: cacheAnnotation({ ttl: 60_000 }) });
  await mw.interceptQuery?.(exec, ctx);
  await mw.onRow?.({ id: 1 }, exec, ctx);
  return exec;
}

async function finishMiss(
  mw: CacheMiddleware,
  exec: MockExec,
  ctx: RuntimeMiddlewareContext,
): Promise<void> {
  await mw.afterQuery?.(
    exec,
    { rowCount: 1, latencyMs: 0, completed: true, source: 'driver' },
    ctx,
  );
}

describe('createCacheMiddleware — invalidate({ keys })', () => {
  it('deletes each key from the store in order', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });

    await mw.invalidate({ keys: ['user-1', 'user-2'] });

    expect(store.deleteSpy.mock.calls).toEqual([['user-1'], ['user-2']]);
  });

  it('removes a cached entry so the next read misses', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const exec = makeExec('select 1', {
      cache: cacheAnnotation({ ttl: 60_000, key: 'user-1' }),
    });
    const ctx = makeCtx();
    await runMiss(mw, exec, ctx, [{ id: 1 }]);
    expect(await mw.interceptQuery?.(exec, ctx)).toBeDefined();

    await mw.invalidate({ keys: ['user-1'] });

    expect(await mw.interceptQuery?.(exec, ctx)).toBeUndefined();
  });

  it('calls delete with the store as this', async () => {
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
    }
    const store = new MapStore();
    store.entries.set('user-1', { rows: [], storedAt: 0 });
    store.entries.set('user-2', { rows: [], storedAt: 0 });
    store.entries.set('post-1', { rows: [], storedAt: 0 });
    const mw = createCacheMiddleware({ store });

    await mw.invalidate({ keys: ['user-1', 'user-2'] });

    expect([...store.entries.keys()]).toEqual(['post-1']);
  });

  it('does not call the store or move the counter when keys are empty', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const ctx = makeCtx();
    const exec = await startMiss(mw, ctx);

    await mw.invalidate({ keys: [] });
    await finishMiss(mw, exec, ctx);

    expect(store.deleteSpy).not.toHaveBeenCalled();
    expect(store.setSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps earlier deletions and propagates the error when a delete rejects partway', async () => {
    const store = spyStore();
    const failure = new Error('delete failed');
    store.deleteSpy.mockImplementation(async (key: string) => {
      if (key === 'b') {
        throw failure;
      }
      store.inner.delete(key);
    });
    for (const key of ['a', 'b', 'c']) {
      store.inner.set(key, { rows: [], storedAt: 0 });
    }
    const mw = createCacheMiddleware({ store });
    const ctx = makeCtx();
    const exec = await startMiss(mw, ctx);

    await expect(mw.invalidate({ keys: ['a', 'b', 'c'] })).rejects.toBe(failure);
    await finishMiss(mw, exec, ctx);

    expect(store.deleteSpy.mock.calls).toEqual([['a'], ['b']]);
    expect([...store.inner.keys()]).toEqual(['b', 'c']);
    expect(store.setSpy).not.toHaveBeenCalled();
  });

  describe('against a store without delete', () => {
    it('refuses with RUNTIME.CACHE_STORE_CANNOT_INVALIDATE', async () => {
      const store = spyStore();
      const mw = createCacheMiddleware({ store: { get: store.get, set: store.set } });

      await expect(mw.invalidate({ keys: ['user-1'] })).rejects.toMatchObject({
        code: 'RUNTIME.CACHE_STORE_CANNOT_INVALIDATE',
        meta: { missingMethod: 'delete' },
      });
    });

    it('refuses before moving the counter, so an in-flight miss still stores its rows', async () => {
      const store = spyStore();
      const mw = createCacheMiddleware({ store: { get: store.get, set: store.set } });
      const ctx = makeCtx();
      const exec = await startMiss(mw, ctx);

      await expect(mw.invalidate({ keys: ['user-1'] })).rejects.toMatchObject({
        code: 'RUNTIME.CACHE_STORE_CANNOT_INVALIDATE',
      });
      await finishMiss(mw, exec, ctx);

      expect(store.setSpy).toHaveBeenCalledTimes(1);
    });

    it('accepts empty keys', async () => {
      const store = spyStore();
      const mw = createCacheMiddleware({ store: { get: store.get, set: store.set } });

      await expect(mw.invalidate({ keys: [] })).resolves.toBeUndefined();
    });
  });
});

describe('createCacheMiddleware — invalidate(run)', () => {
  it('calls the function once with no arguments', async () => {
    const mw = createCacheMiddleware({ store: spyStore() });
    const run = vi.fn(async () => {});

    await mw.invalidate(run);

    expect(run.mock.calls).toEqual([[]]);
  });

  it('moves the counter before the function runs', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const debug = vi.fn();
    const ctx = makeCtx({ log: { info: () => {}, warn: () => {}, error: () => {}, debug } });
    const exec = await startMiss(mw, ctx);

    await mw.invalidate(() => finishMiss(mw, exec, ctx));

    expect(store.setSpy).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith({
      event: 'middleware.cache.store-skipped',
      middleware: 'cache',
      key: 'key:select 1',
    });
  });

  it('propagates a rejection after moving the counter, so an overlapping miss skips its store', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const ctx = makeCtx();
    const exec = await startMiss(mw, ctx);
    const failure = new Error('run failed');

    await expect(mw.invalidate(() => Promise.reject(failure))).rejects.toBe(failure);
    await finishMiss(mw, exec, ctx);

    expect(store.setSpy).not.toHaveBeenCalled();
  });

  it('turns a synchronous throw into a rejection', async () => {
    const mw = createCacheMiddleware({ store: spyStore() });
    const failure = new Error('run failed');

    await expect(
      mw.invalidate(() => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it('runs against a store without delete', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store: { get: store.get, set: store.set } });
    const run = vi.fn(async () => {});

    await mw.invalidate(run);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('createCacheMiddleware — reads overlapping invalidate', () => {
  it('does not store rows from a miss that an invalidate overlapped', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const debug = vi.fn();
    const ctx = makeCtx({
      log: { info: () => {}, warn: () => {}, error: () => {}, debug },
    });
    const exec = await startMiss(mw, ctx);

    await mw.invalidate({ keys: ['user-1'] });
    await finishMiss(mw, exec, ctx);

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

    await mw.invalidate({ keys: ['user-1'] });
    await mw.invalidate(async () => {});
    await runMiss(mw, exec, ctx, [{ id: 1 }]);

    expect(store.setSpy).toHaveBeenCalledTimes(1);
  });
});
