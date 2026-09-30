import {
  cacheAnnotation,
  createCacheMiddleware,
  createInMemoryCacheStore,
} from '@internal/middleware-cache';
import { sql } from '@internal/sql-builder/runtime';
import type { Runtime } from '@internal/sql-runtime';
import { timeouts } from '@repo/test-utils';
import { describe, expect, it } from 'vitest';
import { useMiddlewareCacheDatabase } from './middleware-cache-database';

/*
 * Integration tests for `invalidate` on `@internal/middleware-cache` against real Postgres:
 * invalidating by key, or by a function that deletes entries whose attributes match, makes the
 * next read see a write that happened after the rows were cached.
 */

function hasTags(attributes: unknown): attributes is { readonly tags: readonly unknown[] } {
  return (
    typeof attributes === 'object' &&
    attributes !== null &&
    'tags' in attributes &&
    Array.isArray(attributes.tags)
  );
}

describe('integration: middleware-cache invalidation against real Postgres', {
  timeout: timeouts.databaseOperation,
}, () => {
  const database = useMiddlewareCacheDatabase();
  const { buildRuntime } = database;

  function readUserOneName(runtime: Runtime) {
    const db = sql({ context: database.context, rawCodecInferer: { inferCodec: () => 'pg/text' } });
    return runtime
      .query(
        db.public.users
          .select('name')
          .where((f, fns) => fns.eq(f.id, 1))
          .annotate(
            cacheAnnotation({ ttl: 60_000, key: 'user-1', attributes: { tags: ['users'] } }),
          )
          .build(),
      )
      .toArray();
  }

  it.each([
    {
      by: 'key',
      setUp: () => {
        const cache = createCacheMiddleware({ maxEntries: 100 });
        return { cache, invalidate: () => cache.invalidate({ keys: ['user-1'] }) };
      },
    },
    {
      by: 'attributes',
      setUp: () => {
        const store = createInMemoryCacheStore({ maxEntries: 100 });
        const cache = createCacheMiddleware({ store });
        const invalidate = () =>
          cache.invalidate(() =>
            store.deleteWhere((e) => hasTags(e.attributes) && e.attributes.tags.includes('users')),
          );
        return { cache, invalidate };
      },
    },
  ])('a read after invalidating by $by sees the committed write', async ({ setUp }) => {
    const { cache, invalidate } = setUp();
    const runtime = buildRuntime([cache]);

    try {
      expect(await readUserOneName(runtime)).toEqual([{ name: 'Alice' }]);

      await database.client.query(`UPDATE users SET name = 'Alicia' WHERE id = 1`);
      database.driverQuerySpy.mockClear();

      expect(await readUserOneName(runtime)).toEqual([{ name: 'Alice' }]);
      expect(database.driverQuerySpy).not.toHaveBeenCalled();

      await invalidate();

      expect(await readUserOneName(runtime)).toEqual([{ name: 'Alicia' }]);
      expect(database.driverQuerySpy).toHaveBeenCalledTimes(1);
    } finally {
      await database.client.query(`UPDATE users SET name = 'Alice' WHERE id = 1`);
    }
  });
});
