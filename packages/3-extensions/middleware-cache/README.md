# @internal/middleware-cache

A family-agnostic, opt-in caching middleware for Prisma 8 runtimes.

Built on the `interceptQuery` hook on `RuntimeMiddleware`: on a cache hit, the middleware short-circuits the query and returns the cached rows; the driver is never invoked. On a cache miss, the middleware buffers rows from the driver and commits them to the store on successful completion.

The package depends on no SQL or Mongo package: its runtime dependencies are `@internal/framework-components` and `@internal/utils`. The default cache key is `RuntimeMiddlewareContext.contentHash(exec)`, which the family runtime populates, so SQL and Mongo runtimes both work out of the box.

## Responsibilities

- Provide an opt-in caching `RuntimeMiddleware` that short-circuits repeated reads via the `interceptQuery` hook.
- Define the `cacheAnnotation` handle (read-only) that lane terminals (SQL DSL `.annotate(...)`, ORM read terminals) use to attach per-query cache parameters (`ttl`, `skip`, `key`, `attributes`).
- Resolve the cache key per execution: per-query `cacheAnnotation({ key })` override, otherwise the `deriveKey` option, which defaults to `RuntimeMiddlewareContext.contentHash(exec)` from the family runtime.
- Buffer driver rows on a miss and commit to the `CacheStore` only on successful completion (`completed: true && source: 'driver'`).
- Bypass the cache when `RuntimeMiddlewareContext.scope` is `'connection'` or `'transaction'`.
- Remove entries on request through `invalidate`, by key or by a function the caller supplies, and stop a read that overlapped an `invalidate` from storing its rows.
- Ship a default in-memory LRU-with-TTL store with `deleteWhere`, and expose the `CacheStore` interface for pluggable backends (Redis, Memcached, etc.).

## Quick start

```typescript
import postgres from '@internal/postgres/runtime';
import {
  cacheAnnotation,
  createCacheMiddleware,
} from '@internal/middleware-cache';
import type { Contract } from './contract.d';
import contractJson from './contract.json' with { type: 'json' };

const db = postgres<Contract>({
  contractJson,
  url: process.env['DATABASE_URL']!,
  middleware: [createCacheMiddleware({ maxEntries: 1000 })],
});

// First call: hits the database, caches the raw rows.
const first = await db.orm.public.User.first({ id: 1 }, (meta) =>
  meta.annotate(cacheAnnotation({ ttl: 60_000 })),
);

// Second call with the identical plan: served from cache, driver
// not invoked.
const second = await db.orm.public.User.first({ id: 1 }, (meta) =>
  meta.annotate(cacheAnnotation({ ttl: 60_000 })),
);

// Un-annotated queries are never cached — caching is strictly opt-in.
const fresh = await db.orm.public.User.first({ id: 1 }); // always hits the DB
```

## Opt-in by annotation

The cache middleware acts only on plans that carry a `cacheAnnotation` payload with a TTL: the annotation's `ttl`, or the middleware's `defaultTtlMs` option when the annotation has none:

| Annotation state | Behavior |
|---|---|
| No `cacheAnnotation` on the plan | Pass through; never cached, even with `defaultTtlMs`. |
| `cacheAnnotation({ })` (no `ttl`), no `defaultTtlMs` | Pass through; never cached. |
| `cacheAnnotation({ })` (no `ttl`), with `defaultTtlMs` | Cache lookup; commit with `defaultTtlMs`. |
| `cacheAnnotation({ skip: true })` | Pass through; never cached. |
| `cacheAnnotation({ ttl })` | Cache lookup; commit on miss + success. |
| `cacheAnnotation({ ttl, key })` | As above, but use the supplied key verbatim. |
| `cacheAnnotation({ ttl, attributes })` | As above; the stored entry carries `attributes` (see [Attributes](#attributes)). |

```typescript
const middleware = createCacheMiddleware({ defaultTtlMs: 30_000 });

// Cached for 30s: the annotation opts in, the default supplies the TTL.
await db.orm.public.User.first({ id }, (meta) => meta.annotate(cacheAnnotation({})));
```

The annotation is **read-only**: it declares `applicableTo: ['read']`, so the lane gate (TML-2143 M2) rejects passing it to write terminals at both type and runtime levels. "Cache a mutation" is structurally impossible without an `as any` cast bypass at both the type and runtime levels — the cache middleware itself ships without any mutation classifier.

```typescript
// ✓ ORM read terminal accepts the read-only annotation via the meta callback.
await db.orm.public.User.first({ id }, (meta) => meta.annotate(cacheAnnotation({ ttl: 60_000 })));

// ✓ Bare-configurator form on `first` — pass `undefined` as the filter to
// attach an annotation without narrowing further. Also valid: chain
// `.where(...)` before `.first(undefined, ...)`.
await db.orm.public.User.first(undefined, (meta) => meta.annotate(cacheAnnotation({ ttl: 60_000 })));

// ✗ Type error: write terminal rejects read-only annotation.
await db.orm.public.User.create(input, (meta) => meta.annotate(cacheAnnotation({ ttl: 60_000 })));

// ✓ SQL DSL: chainable on select / grouped builders.
const plan = db.sql
  .from(tables.user)
  .select({ id: tables.user.columns.id })
  .annotate(cacheAnnotation({ ttl: 60_000 }))
  .build();
```

## Cache key composition

Three-tier resolution:

1. **Per-query override.** `cacheAnnotation({ key })` — the supplied string is used verbatim, and `deriveKey` is not called. The cache middleware does **not** rehash user-supplied keys; the caller is responsible for keeping the string bounded in size and free of sensitive data they do not want flowing into debug logs, Redis `KEYS` output, persistence dumps, or any user-supplied `CacheStore`. User-supplied keys also bypass the storage-hash discrimination below — if you fix a key, prefix it with something tied to your schema version (e.g. `` `${storageHash}:my-key` ``) to avoid serving stale-schema entries after a migration.
2. **`deriveKey`.** `createCacheMiddleware({ deriveKey })` computes the key of every cached read whose annotation has no `key` (see [Deriving keys](#deriving-keys)).
3. **Default.** `deriveKeyFromContentHash(exec, ctx)`, which returns `RuntimeMiddlewareContext.contentHash(exec)` — the family runtime owns this. The SQL and Mongo runtimes today compose `meta.storageHash + '|' + …` and pipe the result through `hashContent` (SHA-512), producing a bounded, opaque digest of the form `sha512:HEXDIGEST`. The cache middleware uses the returned string directly as the store key.

Two consequences worth pinning (both properties of the **default** key path — user-supplied keys above opt out of both, and a `deriveKey` keeps them only if it builds on the content hash):

- **Storage-hash discrimination.** A schema migration changes `meta.storageHash`, which changes `contentHash`, which invalidates cached entries automatically. Stale-schema reads cannot leak across migrations.
- **AST rewrites are part of the key.** Middleware that rewrite the plan via `beforeCompile` (e.g. soft-delete) run **upstream** of the cache. The cache sees the post-lowering plan, so the rewritten SQL is part of the content hash. Adding or removing a `beforeCompile` middleware changes which entries hit.

### Deriving keys

`deriveKey(exec, ctx)` returns the key (or a promise of it) for a read that is being cached and has no annotation `key`. It runs on every such read, hit or miss, and never on a read the cache bypasses. Compose it with the exported default to add a prefix:

```typescript
import { createCacheMiddleware, deriveKeyFromContentHash } from '@internal/middleware-cache';

const cache = createCacheMiddleware({
  deriveKey: async (exec, ctx) => `users:${await deriveKeyFromContentHash(exec, ctx)}`,
});
```

- **An explicit annotation `key` bypasses `deriveKey`.** It is used literally, so a tenant or namespace prefix that `deriveKey` adds must also be part of every explicit key.
- **Keys must differ whenever the rows can differ.** A derivation that returns the same key for two different plans serves one plan's rows to the other.
- **Keep the content hash.** A derivation that drops it loses the storage-hash discrimination above, so a migration no longer invalidates cached entries.
- **Errors fail the read.** If `deriveKey` throws or rejects, the read fails; the cache does not fall back to the database. Its latency is added to every cached read, including hits.

## `CacheStore` pluggability

The default in-memory store is per-process and **not** coherent across replicas. For shared caching, supply a custom `CacheStore`:

```typescript
import type { CacheStore, CachedEntry } from '@internal/middleware-cache';

const redis: CacheStore = {
  async get(key) {
    const raw = await redisClient.get(key);
    return raw ? (JSON.parse(raw) as CachedEntry) : undefined;
  },
  async set(key, entry, ttlMs) {
    await redisClient.set(key, JSON.stringify(entry), 'PX', ttlMs);
  },
};

const middleware = createCacheMiddleware({ store: redis });
```

`delete(key)` is optional. A store needs it only to support `invalidate({ keys })` (see [Invalidation](#invalidation)). Group deletion is not part of the interface: each store exposes whatever fits its backend, as the default store does with `deleteWhere`. Delete through `invalidate`, not by calling the store on its own, because only `invalidate` runs the guard for overlapping reads. A store's deletions must take effect after any `set` it has already accepted for the same key, for example by sending both on one connection.

The interface is intentionally minimal — `get` returns the entry if present and not expired (implementations gating on TTL should treat expired as absent), `set` writes the entry under the key with the per-call `ttlMs`. Every method is async to leave room for I/O-backed stores; the default in-memory store completes synchronously and wraps results in `Promise.resolve` for type conformance.

## Attributes

`cacheAnnotation({ attributes })` attaches any value to the stored entry. The middleware never reads it; it copies it onto `CachedEntry.attributes` for policies built on top, such as the tags example below. An annotation without `attributes` stores an entry without that property.

- **Stored by reference.** The entry holds the value you passed. Do not mutate it after the read, and keep it small: it lives as long as the entry.
- **Serialisable for serialising stores.** A store that serialises entries (Redis) needs `attributes` to survive that serialisation. The default store has no such requirement.

## Invalidation

`invalidate` has two forms. Both make every read that missed the cache before the call skip storing its rows, then remove entries.

### By key

```typescript
const cache = createCacheMiddleware();
const db = postgres<Contract>({ contractJson, url, middleware: [cache] });

await db.orm.public.User.first({ id: 1 }, (meta) =>
  meta.annotate(cacheAnnotation({ ttl: 60_000, key: 'user-1' })),
);

await db.orm.public.User.where({ id: 1 }).update({ name: 'Alicia' });

await cache.invalidate({ keys: ['user-1'] });
```

Keys are compared literally with the strings passed to `cacheAnnotation({ key })`. The keys form is a convenience built on the same guard as the function form: it calls the store's `delete` for each key, in order. It is the only form that checks the store: when the store has no `delete`, it throws `RUNTIME.CACHE_STORE_CANNOT_INVALIDATE` (with `meta.missingMethod: 'delete'`) before anything else, even for empty `keys`. On a store with `delete`, empty `keys` do nothing.

### By a function

`invalidate(run)` makes in-flight misses skip their store, then awaits `run`. `run` receives no argument: it deletes through a store reference you hold. To use the default store's `deleteWhere`, create the store yourself and pass it in:

```typescript
import {
  createCacheMiddleware,
  createInMemoryCacheStore,
  deriveKeyFromContentHash,
} from '@internal/middleware-cache';

const store = createInMemoryCacheStore({ maxEntries: 1_000 });
const cache = createCacheMiddleware({
  store,
  deriveKey: async (exec, ctx) => `users:${await deriveKeyFromContentHash(exec, ctx)}`,
});

await cache.invalidate(() => store.deleteWhere((entry) => entry.key.startsWith('users:')));
```

The function form performs no capability check; `run` is responsible for what the store supports. In-flight misses skip their store even when `run` removes nothing.

### Tags: a policy built on attributes

Tags are not built in. Store them in `attributes` and delete by predicate:

```typescript
function hasTags(attributes: unknown): attributes is { readonly tags: readonly unknown[] } {
  return (
    typeof attributes === 'object' &&
    attributes !== null &&
    'tags' in attributes &&
    Array.isArray(attributes.tags)
  );
}

await db.orm.public.User.first({ id: 1 }, (meta) =>
  meta.annotate(cacheAnnotation({ ttl: 60_000, attributes: { tags: ['users'] } })),
);

await cache.invalidate(() =>
  store.deleteWhere((entry) => hasTags(entry.attributes) && entry.attributes.tags.includes('users')),
);
```

A custom store can support the same policy by reading `entry.attributes` in `set`, keeping its own index, and exposing a group delete that `run` calls.

### Rules for both forms

- **Delete through `invalidate`.** Calling `store.delete` or `store.deleteWhere` on its own skips the guard for overlapping reads.
- **Call it after the write has committed.** `invalidate` works from any scope, but if you call it inside a transaction, another request can read the old rows before the commit and put them back in the cache. Invalidate once the transaction has returned.
- **Overlapping reads.** A read that missed the cache before an `invalidate` and finishes after it does not store its rows, because they may predate the write. This guard is per middleware instance and so per process: with a shared store such as Redis, a read in another process is not protected, and can store rows that predate the write. Every `invalidate` call makes every in-flight miss skip its store, whatever it removes, including a function that removes nothing; the only exceptions are a refused keys call and empty `keys`. Frequent invalidation therefore lowers the hit rate. Each skipped store is logged at debug level as `middleware.cache.store-skipped` with the key. If an `invalidate` runs while a miss's `store.set` is still in flight, the middleware deletes that key again once the `set` resolves; with a store whose `set` is asynchronous and that has no `delete`, a write that lands during an invalidation cannot be removed.
- **Until `invalidate` resolves,** reads can still return entries it has not removed yet.
- **Store errors.** If the store's `delete`, or `run`, rejects partway, `invalidate` rejects with that error; entries already removed stay removed, and calling `invalidate` again is safe. In-flight misses still skip their store.

## Transaction-scope guard

The middleware bypasses the cache entirely when `RuntimeMiddlewareContext.scope` is `'connection'` or `'transaction'`. Only top-level `runtime.query` (`scope === 'runtime'`) consults the store.

This avoids two surprises:

- Inside a transaction, the caller expects read-after-write coherence with their own writes — the cache cannot meaningfully serve those reads without tracking the transaction's pending writes, which is out of scope for this milestone.
- On a checked-out connection (`runtime.connection().query(...)`), the caller has explicitly stepped outside the shared runtime surface and likely does not expect the global cache to inject results.

## TTL and LRU semantics

The default `createInMemoryCacheStore({ maxEntries, clock? })`:

- **TTL.** Each entry is committed with the per-query `ttl`, or the middleware's `defaultTtlMs` when the annotation has none (in milliseconds). The store evaluates expiry against its injected clock (defaults to `Date.now`); reads of expired entries return `undefined` and drop the entry as a side effect.
- **`deleteWhere(predicate)`.** Removes every live entry for which `predicate({ key, attributes })` returns `true`, and every expired entry without offering it to `predicate`. It scans all entries synchronously, so its cost grows with `maxEntries`, and it does not change LRU order. A throwing `predicate` rejects the returned promise; entries removed before the throw stay removed. `createInMemoryCacheStore` returns `InMemoryCacheStore`, whose `delete` and `deleteWhere` are both required.
- **LRU.** Iteration order is the LRU order. Reads and writes both bump recency. When the live count would exceed `maxEntries`, the oldest entry is evicted.
- **Failure handling.** The middleware commits to the store only when `afterQuery` reports `completed: true && source: 'driver'`. Driver errors mid-stream and middleware-served queries never populate the cache.

## Caveats

- **Default store is not coherent across replicas.** Multiple processes / pods do not share state. Use a custom `CacheStore` (Redis, etc.) for cross-process coherence.
- **Concurrent misses both populate the store.** Two concurrent first-time reads of the same key both run the driver and both commit; last writer wins. Request coalescing is out of this package's scope (see [Scope](#scope)).
- **Reads of stale-on-arrival entries.** With a custom replicated store, a follower may serve a stale entry for a brief window after the writer commits. Use the storage-hash discrimination plus a sensible TTL.
- **Writes do not invalidate on their own.** The middleware never observes writes. Call `invalidate` after a write that changes cached reads, choose a TTL short enough to bound the staleness window, or pass `cacheAnnotation({ skip: true })` on the read that needs to be authoritative.

## Scope

This package is a read-through cache with a control surface. Its primitives are:

- keys: the annotation `key`, and the `deriveKey` option with its default `deriveKeyFromContentHash`;
- `attributes` on the annotation and the stored entry;
- `invalidate`, by keys or by a function;
- `defaultTtlMs`;
- the `CacheStore` interface, and `deleteWhere` on the default store.

It never decides when to remove an entry. Tagging schemes, deletion strategies, request coalescing and routing between several stores are policy, and belong in separate extensions built on these primitives. Such extensions delete through `invalidate`, because only `invalidate` stops overlapping reads from storing rows that predate the write. The `CacheStore` interface is the extension point for backends, not for invalidation.

The primitives do not cover two things:

- **Write-driven invalidation from inside a transaction.** An extension that invalidates on writes must wait for the commit, and an `afterExecute` hook inside a transaction runs before it. The runtime has no post-commit hook today; adding one is separate framework work.
- **Serve-stale strategies** such as stale-while-revalidate. Only the middleware decides hit or miss, so nothing outside it can serve an expired entry while it re-runs the query.

## See also

- [Runtime & Middleware Framework](../../../docs/architecture%20docs/subsystems/4.%20Runtime%20&%20Middleware%20Framework.md) for the SPI and middleware lifecycle (including the `interceptQuery` hook the cache uses).
- [ADR 204 — Single-tier runtime](../../../docs/architecture%20docs/adrs/ADR%20204%20-%20Single-tier%20runtime.md) for why the cache middleware is family-agnostic by construction.
