import { describe, expect, it } from 'vitest';
import { cacheAnnotation } from '../src/cache-annotation';
import { createCacheMiddleware } from '../src/cache-middleware';
import { makeCtx, makeExec, runMiss, spyStore } from './middleware-fixtures';

describe('createCacheMiddleware — meta', () => {
  it('forwards the annotation meta to store.set by reference', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const meta = { tags: ['users', 'posts'] };
    const exec = makeExec('select 1', { cache: cacheAnnotation({ meta }) });

    await runMiss(mw, exec, makeCtx(), [{ id: 1 }]);

    expect(store.setSpy).toHaveBeenCalledWith({
      key: 'key:select 1',
      meta: { tags: ['users', 'posts'] },
      entry: { rows: [{ id: 1 }] },
    });
    expect(store.setSpy.mock.calls[0]?.[0].meta).toBe(meta);
  });

  it('passes meta: undefined to store.set when the annotation has none', async () => {
    const store = spyStore();
    const mw = createCacheMiddleware({ store });
    const exec = makeExec('select 1', { cache: cacheAnnotation({ key: 'user-1' }) });

    await runMiss(mw, exec, makeCtx(), [{ id: 1 }]);

    expect(store.setSpy).toHaveBeenCalledWith({
      key: 'user-1',
      meta: undefined,
      entry: { rows: [{ id: 1 }] },
    });
  });
});
