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

A read-through cache middleware: on a hit it returns cached rows and never invokes the driver; on a miss it buffers the driver's rows and stores them when the read completes. A read opts in with `cacheAnnotation({ key?, meta?, bypass? })`: `key` names the entry, otherwise the `deriveKey` option computes it (default: the family runtime's content hash, `deriveKeyFromContentHash`); `meta` is handed to the store with the entry; `bypass: true` skips the cache for that call. Connection- and transaction-scoped executions bypass the cache.

How long an entry lives is the store's policy. The default store, `createInMemoryCacheStore({ maxEntries?, ttlMs?, clock? })`, keeps up to 1000 entries for 60 seconds each; `ttlMs: Infinity` never expires, and a `maxEntries` that is not a positive integer or a `ttlMs` that is not positive throws `RUNTIME.ARGUMENT_INVALID`. Implement the `CacheStore` interface to use Redis, Memcached, or any other backend.

## The store

```ts
interface CacheStore {
  get(key: string): Promise<CachedEntry | undefined>;
  set(target: { readonly key: string; readonly meta: unknown; readonly entry: CachedEntry }): Promise<void>;
  unset(target: { readonly keys: readonly string[] | undefined; readonly meta: unknown }): Promise<void>;
}
```

`set` stores one entry with the read annotation's `meta`. `unset` removes every entry named in `keys` (`undefined` or non-empty) and every entry that matches `meta`, and an `unset` by key also drops that key from any `meta` index. The middleware's `unset` after a stale `set` may remove a fresher entry under the same key, which costs one miss. The store interprets `meta` on both sides; the middleware never does. A store that cannot act on a `meta` given to `unset` must throw: the default store throws `RUNTIME.CACHE_STORE_META_UNSUPPORTED`. When `set` resolves, the entry must be visible to a later `unset` of the same key. `unset` must not run queries through the runtime that uses the middleware.

## Typed meta

`CacheStore<TMeta>`, `createCacheMiddleware` and `cacheAnnotation<TMeta>` take the shape of `meta` as a type parameter; it defaults to `unknown`. `createCacheMiddleware` infers it from the store, so `invalidate` accepts only that shape:

```typescript
interface TagMeta {
  tags: string[];
}

class TagStore implements CacheStore<TagMeta> {
  // get, set({ key, meta, entry }), unset({ keys, meta }) with meta: TagMeta | undefined
}

const cache = createCacheMiddleware({ store: new TagStore() }); // CacheMiddleware<TagMeta>
await cache.invalidate({ meta: { tags: ['users'] } }); // compiles
await cache.invalidate({ meta: { tag: 'users' } }); // type error
```

Nothing ties the annotation's `TMeta` to the store's at compile time, because the annotation is written where the query is and the store where the middleware is set up. A store package should therefore export a wrapper typed with its own meta, so the two agree:

```typescript
export const cached = (o: CacheAnnotationOptions<TagMeta>) => cacheAnnotation<TagMeta>(o);
```

## Deriving keys

`createCacheMiddleware({ deriveKey })` computes the key of every cached read whose annotation has no `key`. Build on the default to add a prefix:

```ts
const cache = createCacheMiddleware({
  deriveKey: async (exec, ctx) => `users:${await deriveKeyFromContentHash(exec, ctx)}`,
});
```

An explicit annotation `key` is used literally and bypasses `deriveKey`, so a tenant or namespace prefix must be part of it too. A derivation that returns the same key for different plans serves one plan's rows to the other, and one that drops the content hash no longer changes on a schema migration. If `deriveKey` throws, the read fails.

## Invalidation

`invalidate({ keys?, meta? })` removes entries through one `store.unset({ keys, meta })` call, and does nothing when there are no keys and no `meta`.

```ts
const cache = createCacheMiddleware();

await db.orm.public.User.first({ id: 1 }, (meta) =>
  meta.annotate(cacheAnnotation({ key: 'user-1' })),
);

await db.orm.public.User.where({ id: 1 }).update({ name: 'Alicia' });
await cache.invalidate({ keys: ['user-1'] });
```

A read that missed before an `invalidate` and finishes after it does not store its rows: `invalidate({ keys })` stops the reads for those keys, and `invalidate({ meta })` stops every read in flight, because only the store knows what `meta` matches. This guard works within one process only. A miss whose `afterQuery` never runs (an abandoned row stream, or an earlier middleware's `afterQuery` throwing) leaves one small counter for its key in memory, bounded by distinct keys. Call `invalidate` after the write has committed: inside a transaction, another request can put the old rows back in the cache before the commit. An error from the store propagates.

A tag scheme is a store policy: `cacheAnnotation({ meta: { tags: ['users'] } })` on the read, a store that indexes `meta.tags` in `set`, and `cache.invalidate({ meta: { tags: ['users'] } })` after the write.

## Scope

The middleware is a read-through cache with a control surface: keys and `deriveKey`, `meta`, `bypass`, `invalidate`, and the `CacheStore` interface. It carries data between the annotations and the store and never interprets it. Lifetime and the meaning of `meta` are the store's; deciding what to invalidate and when, request coalescing and routing between several stores belong in extensions built on these primitives.

Invalidating as part of a write is not supported yet: it must wait for the transaction to commit, including the transactions the ORM opens for its own `update()` and `delete()`, and the runtime has no post-commit hook. Until then, call `invalidate` after the write returns. Serve-stale strategies such as stale-while-revalidate need the hit-or-miss decision, which only the middleware makes.
