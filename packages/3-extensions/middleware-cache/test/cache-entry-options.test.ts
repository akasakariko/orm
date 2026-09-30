import { describe, expect, it } from 'vitest';
import { cacheAnnotation } from '../src/cache-annotation';
import { createCacheMiddleware } from '../src/cache-middleware';
import { makeCtx, makeExec, runMiss, spyStore } from './middleware-fixtures';

describe('createCacheMiddleware — tags', () => {
  it('copies the annotation tags onto the stored entry', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store, clock: () => 5 });
    const exec = makeExec('select 1', {
      cache: cacheAnnotation({ ttl: 60_000, tags: ['users', 'posts'] }),
    });

    await runMiss(mw, exec, makeCtx(), [{ id: 1 }]);

    expect(store.setSpy).toHaveBeenCalledWith(
      'key:select 1',
      { rows: [{ id: 1 }], storedAt: 5, tags: ['users', 'posts'] },
      60_000,
    );
  });

  it('stores an entry without a tags property when the annotation has no tags', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const exec = makeExec('select 1', { cache: cacheAnnotation({ ttl: 60_000 }) });

    await runMiss(mw, exec, makeCtx(), [{ id: 1 }]);

    expect(store.inner.get('key:select 1')).not.toHaveProperty('tags');
  });
});

describe('createCacheMiddleware — defaultTtlMs', () => {
  it('caches an annotation without ttl for the default TTL', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store, defaultTtlMs: 5_000 });
    const exec = makeExec('select 1', { cache: cacheAnnotation({}) });

    await runMiss(mw, exec, makeCtx(), [{ id: 1 }]);

    expect(store.setSpy).toHaveBeenCalledTimes(1);
    expect(store.setSpy.mock.calls[0]?.[2]).toBe(5_000);
  });

  it('keeps the annotation ttl over the default', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store, defaultTtlMs: 5_000 });
    const exec = makeExec('select 1', { cache: cacheAnnotation({ ttl: 60_000 }) });

    await runMiss(mw, exec, makeCtx(), [{ id: 1 }]);

    expect(store.setSpy.mock.calls[0]?.[2]).toBe(60_000);
  });

  it('passes through an annotation without ttl when there is no default', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const exec = makeExec('select 1', { cache: cacheAnnotation({}) });

    await runMiss(mw, exec, makeCtx(), [{ id: 1 }]);

    expect(store.getSpy).not.toHaveBeenCalled();
    expect(store.setSpy).not.toHaveBeenCalled();
  });

  it('passes through an annotation with skip: true', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store, defaultTtlMs: 5_000 });
    const exec = makeExec('select 1', { cache: cacheAnnotation({ skip: true }) });

    await runMiss(mw, exec, makeCtx(), [{ id: 1 }]);

    expect(store.getSpy).not.toHaveBeenCalled();
    expect(store.setSpy).not.toHaveBeenCalled();
  });

  it('never caches a read without the annotation', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store, defaultTtlMs: 5_000 });
    const exec = makeExec('select 1');

    await runMiss(mw, exec, makeCtx(), [{ id: 1 }]);

    expect(store.getSpy).not.toHaveBeenCalled();
    expect(store.setSpy).not.toHaveBeenCalled();
  });
});
