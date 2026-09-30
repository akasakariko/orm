import type { RuntimeMiddlewareContext } from '@internal/framework-components/runtime';
import { describe, expect, it, vi } from 'vitest';
import { cacheAnnotation } from '../src/cache-annotation';
import { type CacheMiddleware, createCacheMiddleware } from '../src/cache-middleware';
import type { CacheStore } from '../src/cache-store';
import { type MockExec, makeCtx, makeExec, runMiss, spyStore } from './middleware-fixtures';

async function startMiss(
  mw: CacheMiddleware,
  ctx: RuntimeMiddlewareContext,
  key: string,
): Promise<MockExec> {
  const exec = makeExec(`select ${key}`, { cache: cacheAnnotation({ key }) });
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

function debugCtx() {
  const debug = vi.fn();
  const ctx = makeCtx({ log: { info: () => {}, warn: () => {}, error: () => {}, debug } });
  return { ctx, debug };
}

const skipped = (key: string) => ({
  event: 'middleware.cache.store-skipped',
  middleware: 'cache',
  key,
});

describe('createCacheMiddleware — invalidate', () => {
  it('unsets keys in one store call', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });

    await mw.invalidate({ keys: ['user-1', 'user-2'] });

    expect(store.unsetSpy.mock.calls).toEqual([[{ keys: ['user-1', 'user-2'], meta: undefined }]]);
  });

  it('unsets by meta in one store call', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });

    await mw.invalidate({ meta: { tags: ['users'] } });

    expect(store.unsetSpy.mock.calls).toEqual([[{ keys: undefined, meta: { tags: ['users'] } }]]);
  });

  it('unsets keys and meta together in one store call', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });

    await mw.invalidate({ keys: ['user-1'], meta: { tags: ['users'] } });

    expect(store.unsetSpy.mock.calls).toEqual([[{ keys: ['user-1'], meta: { tags: ['users'] } }]]);
  });

  it('treats meta: null as a meta to unset', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });

    await mw.invalidate({ meta: null });

    expect(store.unsetSpy.mock.calls).toEqual([[{ keys: undefined, meta: null }]]);
  });

  it('removes a cached entry so the next read misses', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const exec = makeExec('select 1', { cache: cacheAnnotation({ key: 'user-1' }) });
    const ctx = makeCtx();
    await runMiss(mw, exec, ctx, [{ id: 1 }]);
    expect(await mw.interceptQuery?.(exec, ctx)).toBeDefined();

    await mw.invalidate({ keys: ['user-1'] });

    expect(await mw.interceptQuery?.(exec, ctx)).toBeUndefined();
  });

  it.each([
    ['an empty target', {}],
    ['empty keys', { keys: [] }],
  ])('does nothing for %s, so an overlapping miss still stores', async (_label, target) => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const ctx = makeCtx();
    const exec = await startMiss(mw, ctx, 'user-1');

    await mw.invalidate(target);
    await finishMiss(mw, exec, ctx);

    expect(store.unsetSpy).not.toHaveBeenCalled();
    expect(store.setSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates a store error, and an overlapping miss for the key still skips its store', async () => {
    const store = spyStore();
    const failure = new Error('unset failed');
    store.unsetSpy.mockRejectedValueOnce(failure);
    const mw = createCacheMiddleware({ store });
    const ctx = makeCtx();
    const exec = await startMiss(mw, ctx, 'user-1');

    await expect(mw.invalidate({ keys: ['user-1'] })).rejects.toBe(failure);
    await finishMiss(mw, exec, ctx);

    expect(store.setSpy).not.toHaveBeenCalled();
  });

  it('rejects a meta target against the default store', async () => {
    const mw = createCacheMiddleware();

    await expect(mw.invalidate({ meta: { tags: ['users'] } })).rejects.toMatchObject({
      code: 'RUNTIME.CACHE_STORE_META_UNSUPPORTED',
    });
  });
});

describe('createCacheMiddleware — misses overlapping invalidate', () => {
  it('stores a miss for key A that overlapped invalidate({ keys: ["B"] })', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const ctx = makeCtx();
    const exec = await startMiss(mw, ctx, 'A');

    await mw.invalidate({ keys: ['B'] });
    await finishMiss(mw, exec, ctx);

    expect(store.setSpy).toHaveBeenCalledWith({
      key: 'A',
      meta: undefined,
      entry: { rows: [{ id: 1 }] },
    });
  });

  it('skips storing a miss for key A that overlapped invalidate({ keys: ["A"] })', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const { ctx, debug } = debugCtx();
    const exec = await startMiss(mw, ctx, 'A');

    await mw.invalidate({ keys: ['A'] });
    await finishMiss(mw, exec, ctx);

    expect(store.setSpy).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(skipped('A'));
  });

  it('skips storing a miss for key A that overlapped invalidate({ meta })', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const { ctx, debug } = debugCtx();
    const exec = await startMiss(mw, ctx, 'A');

    await mw.invalidate({ meta: { tags: ['users'] } });
    await finishMiss(mw, exec, ctx);

    expect(store.setSpy).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(skipped('A'));
  });

  it('skips storing the second of two misses for key A when A is invalidated after the first stored', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const ctx = makeCtx();
    const first = await startMiss(mw, ctx, 'A');
    const second = await startMiss(mw, ctx, 'A');

    await finishMiss(mw, first, ctx);
    await mw.invalidate({ keys: ['A'] });
    await finishMiss(mw, second, ctx);

    expect(store.setSpy).toHaveBeenCalledTimes(1);
  });

  it('stores a miss that started after an invalidate', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const ctx = makeCtx();

    await mw.invalidate({ keys: ['A'], meta: { tags: ['users'] } });
    await runMiss(mw, makeExec('select A', { cache: cacheAnnotation({ key: 'A' }) }), ctx, []);

    expect(store.setSpy).toHaveBeenCalledTimes(1);
  });

  describe('when an invalidate runs while store.set is in flight', () => {
    function pendingSetStore() {
      const events: string[] = [];
      let landSet: () => void = () => {};
      const store = {
        get: vi.fn(async () => undefined),
        set: vi.fn(
          (target: Parameters<CacheStore['set']>[0]) =>
            new Promise<void>((resolve) => {
              landSet = () => {
                events.push(`set:${target.key}`);
                resolve();
              };
            }),
        ),
        unset: vi.fn(async (target: Parameters<CacheStore['unset']>[0]) => {
          events.push(`unset:${target.keys?.join(',') ?? ''}`);
        }),
      } satisfies CacheStore;
      return { store, events, landSet: () => landSet() };
    }

    it.each([
      ['keys', { keys: ['A'] }, 'unset:A'],
      ['meta', { meta: { tags: ['users'] } }, 'unset:'],
    ])(
      'unsets the key after the set lands (invalidated by %s), and logs the skip',
      async (_label, target, invalidation) => {
        const { store, events, landSet } = pendingSetStore();
        const mw = createCacheMiddleware({ store });
        const { ctx, debug } = debugCtx();
        const exec = await startMiss(mw, ctx, 'A');

        const finishing = finishMiss(mw, exec, ctx);
        await vi.waitFor(() => expect(store.set).toHaveBeenCalledTimes(1));
        await mw.invalidate(target);
        landSet();
        await finishing;

        expect(events).toEqual([invalidation, 'set:A', 'unset:A']);
        expect(store.unset).toHaveBeenLastCalledWith({ keys: ['A'], meta: undefined });
        expect(debug).toHaveBeenCalledWith(skipped('A'));
      },
    );

    it('does not unset after the set when only another key was invalidated', async () => {
      const { store, events, landSet } = pendingSetStore();
      const mw = createCacheMiddleware({ store });
      const ctx = makeCtx();
      const exec = await startMiss(mw, ctx, 'A');

      const finishing = finishMiss(mw, exec, ctx);
      await vi.waitFor(() => expect(store.set).toHaveBeenCalledTimes(1));
      await mw.invalidate({ keys: ['B'] });
      landSet();
      await finishing;

      expect(events).toEqual(['unset:B', 'set:A']);
    });
  });
});
