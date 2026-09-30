import type { MongoMiddleware } from '@internal/mongo-runtime';
import type { SqlMiddleware } from '@internal/sql-runtime';
import { expectTypeOf, test } from 'vitest';
import { type CacheMiddleware, createCacheMiddleware } from '../src/cache-middleware';

test('createCacheMiddleware returns a CacheMiddleware', () => {
  expectTypeOf(createCacheMiddleware()).toEqualTypeOf<CacheMiddleware>();
});

test('a CacheMiddleware fits in a SQL middleware list', () => {
  const middleware: SqlMiddleware[] = [createCacheMiddleware()];
  expectTypeOf(middleware).toEqualTypeOf<SqlMiddleware[]>();
});

test('a CacheMiddleware fits in a Mongo middleware list', () => {
  const middleware: MongoMiddleware[] = [createCacheMiddleware()];
  expectTypeOf(middleware).toEqualTypeOf<MongoMiddleware[]>();
});
