import { describe, expect, it } from 'vitest';
import { cacheAnnotation } from '../src/cache-annotation';
import { createCacheMiddleware } from '../src/cache-middleware';
import { makeCtx, makeExec, runMiss, spyStore } from './middleware-fixtures';

describe('createCacheMiddleware — attributes', () => {
  it('copies the annotation attributes onto the stored entry by reference', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store, clock: () => 5 });
    const attributes = { tags: ['users', 'posts'] };
    const exec = makeExec('select 1', { cache: cacheAnnotation({ ttl: 60_000, attributes }) });

    await runMiss(mw, exec, makeCtx(), [{ id: 1 }]);

    expect(store.setSpy).toHaveBeenCalledWith(
      'key:select 1',
      { rows: [{ id: 1 }], storedAt: 5, attributes: { tags: ['users', 'posts'] } },
      60_000,
    );
    expect(store.inner.get('key:select 1')?.attributes).toBe(attributes);
  });

  it('stores an entry without an attributes property when the annotation has none', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const exec = makeExec('select 1', { cache: cacheAnnotation({ ttl: 60_000 }) });

    await runMiss(mw, exec, makeCtx(), [{ id: 1 }]);

    expect(store.inner.get('key:select 1')).not.toHaveProperty('attributes');
  });
});

describe('createCacheMiddleware — defaultTtlMs', () => {
  it('caches an annotation without ttl for the default TTL', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store, defaultTtlMs: 5_000, clock: () => 5 });
    const exec = makeExec('select 1', { cache: cacheAnnotation({}) });

    await runMiss(mw, exec, makeCtx(), [{ id: 1 }]);

    expect(store.setSpy).toHaveBeenCalledWith(
      'key:select 1',
      { rows: [{ id: 1 }], storedAt: 5 },
      5_000,
    );
  });

  it('keeps the annotation ttl over the default', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store, defaultTtlMs: 5_000, clock: () => 5 });
    const exec = makeExec('select 1', { cache: cacheAnnotation({ ttl: 60_000 }) });

    await runMiss(mw, exec, makeCtx(), [{ id: 1 }]);

    expect(store.setSpy).toHaveBeenCalledWith(
      'key:select 1',
      { rows: [{ id: 1 }], storedAt: 5 },
      60_000,
    );
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
