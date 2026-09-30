# @prisma/orm-extension-middleware-cache

Opt-in query caching for Prisma 8 runtimes, for both the SQL and Mongo families.

```bash
pnpm add @prisma/orm-extension-middleware-cache
```

The whole surface is the package root:

```ts
import { cacheAnnotation, createCacheMiddleware, type CacheStore } from '@prisma/orm-extension-middleware-cache';
```

## Responsibilities

A runtime middleware that short-circuits repeated reads: on a hit it returns cached rows and never invokes the driver; on a miss it buffers the driver's rows and commits them to the store only when the execution completes successfully. Cache keys come from the family runtime's content hash of the execution, or from a per-query `cacheAnnotation({ key })` override; `ttl`, `skip` and `tags` are per-query too, and `createCacheMiddleware({ defaultTtlMs })` supplies the TTL for an annotated read without one. Connection- and transaction-scoped executions bypass the cache.

It ships an in-memory LRU-with-TTL store and exposes the `CacheStore` interface so Redis, Memcached, or any other backend can be dropped in.

## Invalidation

`createCacheMiddleware()` returns a middleware with an `invalidate` method. `invalidate({ keys })` removes the entries stored under those `cacheAnnotation({ key })` strings; `invalidate({ tags })` removes every entry annotated with at least one of those tags.

```ts
const cache = createCacheMiddleware();

await db.orm.public.User.first({ id: 1 }, (meta) =>
  meta.annotate(cacheAnnotation({ ttl: 60_000, key: 'user-1', tags: ['users'] })),
);

await cache.invalidate({ tags: ['users'] });
```

Invalidating by key needs `CacheStore.delete`, and by tag needs `CacheStore.deleteByTag`; when the store lacks one, `invalidate` throws `RUNTIME.CACHE_STORE_CANNOT_INVALIDATE` before deleting anything. Call `invalidate` after the write has committed: inside a transaction, another request can put the old rows back in the cache before the commit. A read that was in flight when `invalidate` ran does not store its rows; this guard works within one process only, so a shared store such as Redis is not protected against reads in other processes. Any `invalidate` with at least one key or tag that does not throw `RUNTIME.CACHE_STORE_CANNOT_INVALIDATE` makes every in-flight miss skip its store, whatever keys or tags it names, so frequent invalidation lowers the hit rate. If the store's `delete` or `deleteByTag` rejects partway, entries already removed stay removed, and calling `invalidate` again is safe.

## Scope

The middleware is a read-through cache with a control surface. It does not decide when to invalidate: write-driven invalidation, invalidation strategies, request coalescing and routing between several stores are policy, and belong in separate extensions built on `invalidate` and tags. Those extensions invalidate through `invalidate`, not by calling the store's `delete` or `deleteByTag` directly, because calling the store skips the guard for overlapping reads. The `CacheStore` interface is the extension point for backends, not for invalidation.
