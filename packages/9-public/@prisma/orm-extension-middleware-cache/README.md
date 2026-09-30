# @prisma/orm-extension-middleware-cache

Opt-in query caching for Prisma 8 runtimes, for both the SQL and Mongo families.

```bash
pnpm add @prisma/orm-extension-middleware-cache
```

The whole surface is the package root:

```ts
import {
  cacheAnnotation,
  createCacheMiddleware,
  createInMemoryCacheStore,
  deriveKeyFromContentHash,
  type CacheStore,
} from '@prisma/orm-extension-middleware-cache';
```

## Responsibilities

A runtime middleware that short-circuits repeated reads: on a hit it returns cached rows and never invokes the driver; on a miss it buffers the driver's rows and commits them to the store only when the execution completes successfully. Cache keys come from a per-query `cacheAnnotation({ key })`, otherwise from the `deriveKey` option, which defaults to the family runtime's content hash of the execution (`deriveKeyFromContentHash`). `ttl`, `skip` and `attributes` are per-query too, and `createCacheMiddleware({ defaultTtlMs })` supplies the TTL for an annotated read without one. Connection- and transaction-scoped executions bypass the cache.

It ships an in-memory LRU-with-TTL store, `createInMemoryCacheStore`, whose `deleteWhere` removes entries by predicate, and exposes the `CacheStore` interface so Redis, Memcached, or any other backend can be dropped in.

## Attributes

`cacheAnnotation({ attributes })` attaches any value to the stored entry; the middleware never reads it. The entry holds it by reference, so do not mutate it after the read. A store that serialises entries needs it to be serialisable.

## Deriving keys

`createCacheMiddleware({ deriveKey })` computes the key of every cached read whose annotation has no `key`. Build on the default to add a prefix:

```ts
const cache = createCacheMiddleware({
  deriveKey: async (exec, ctx) => `users:${await deriveKeyFromContentHash(exec, ctx)}`,
});
```

An explicit annotation `key` is used literally and bypasses `deriveKey`, so a tenant or namespace prefix must be part of it too. A derivation that returns the same key for different plans serves one plan's rows to the other, and one that drops the content hash no longer changes on a schema migration. If `deriveKey` throws, the read fails.

## Invalidation

`createCacheMiddleware()` returns a middleware with an `invalidate` method in two forms. Both first make every read that missed the cache before the call skip storing its rows.

- `invalidate({ keys })` removes the entries stored under those `cacheAnnotation({ key })` strings through the store's `delete`. It is a convenience over the function form, and the only form that checks the store: without `delete` it throws `RUNTIME.CACHE_STORE_CANNOT_INVALIDATE` before anything else. Empty `keys` do nothing.
- `invalidate(run)` awaits `run`, which receives no argument and deletes through a store reference you hold. To use `deleteWhere`, create the store yourself and pass it in.

Tags are a policy built on these: store them in `attributes` and delete by predicate.

```ts
const store = createInMemoryCacheStore({ maxEntries: 1_000 });
const cache = createCacheMiddleware({ store });

await db.orm.public.User.first({ id: 1 }, (meta) =>
  meta.annotate(cacheAnnotation({ ttl: 60_000, attributes: { tags: ['users'] } })),
);

await cache.invalidate(() =>
  store.deleteWhere((entry) => hasTags(entry.attributes) && entry.attributes.tags.includes('users')),
);
```

Here `hasTags` is your own type predicate for `{ tags: readonly unknown[] }`. Delete through `invalidate`, not by calling the store on its own, because only `invalidate` runs the guard for overlapping reads. Call it after the write has committed: inside a transaction, another request can put the old rows back in the cache before the commit. The guard works within one process only, so a shared store such as Redis is not protected against reads in other processes. Every call that is not refused and has keys, and every function call even if it removes nothing, makes every in-flight miss skip its store, so frequent invalidation lowers the hit rate. If the store's `delete`, or `run`, rejects partway, entries already removed stay removed, and calling `invalidate` again is safe.

## Scope

The middleware is a read-through cache with a control surface: keys and `deriveKey`, `attributes`, `invalidate`, `defaultTtlMs`, the `CacheStore` interface and the default store's `deleteWhere`. It never decides when to remove an entry: tagging schemes, deletion strategies, request coalescing and routing between several stores are policy, and belong in separate extensions built on these primitives. Those extensions delete through `invalidate`, because calling the store on its own skips the guard for overlapping reads. The `CacheStore` interface is the extension point for backends, not for invalidation.

Two things are out of reach of these primitives. Write-driven invalidation from inside a transaction needs a post-commit signal: an `afterExecute` hook in a transaction runs before the commit, and the runtime has no post-commit hook yet. Serve-stale strategies such as stale-while-revalidate need the hit-or-miss decision, which only the middleware makes.
