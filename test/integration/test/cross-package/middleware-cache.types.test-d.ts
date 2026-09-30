import { type CacheMiddleware, createCacheMiddleware } from '@internal/middleware-cache';
import type { MongoMiddleware } from '@internal/mongo-runtime';
import type { SqlMiddleware } from '@internal/sql-runtime';
import { expectTypeOf, test } from 'vitest';

test('createCacheMiddleware returns a CacheMiddleware', () => {
  expectTypeOf(createCacheMiddleware()).toEqualTypeOf<CacheMiddleware>();
});

test('a CacheMiddleware fits in a SQL middleware list', () => {
  const middleware: SqlMiddleware[] = [createCacheMiddleware()];
  void middleware;
});

test('a CacheMiddleware fits in a Mongo middleware list', () => {
  const middleware: MongoMiddleware[] = [createCacheMiddleware()];
  void middleware;
});
