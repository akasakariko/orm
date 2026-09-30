---
changes:
  - id: cache-annotation-ttl-removed
    summary: "cacheAnnotation from @prisma/orm-extension-middleware-cache no longer takes ttl. Every annotated read is now cached, including cacheAnnotation({}) and cacheAnnotation({ key }), which used to pass through uncached; how long an entry lives is the store's policy (the default store: 60 seconds). Remove ttl from every cacheAnnotation call."
    detection:
      glob: "**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}"
      matches:
        - '\bcacheAnnotation\s*\('
  - id: cache-annotation-skip-renamed-bypass
    summary: "cacheAnnotation({ skip }) is now cacheAnnotation({ bypass }), and the CachePayload type is now CacheAnnotationOptions. Detection finds skip written inside a cacheAnnotation({ ... }) literal and any use of CachePayload; options built elsewhere without that type are not detected."
    detection:
      glob: "**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}"
      matches:
        - '\bCachePayload\b'
        - '\bcacheAnnotation\s*\(\s*\{[^}]*\bskip\s*:'
  - id: cache-middleware-store-options
    summary: "createCacheMiddleware no longer takes maxEntries or clock. Pass them to createInMemoryCacheStore and hand that store to createCacheMiddleware({ store }), or drop them when they match the new defaults (1000 entries). Detection finds maxEntries or clock written in the options literal of a createCacheMiddleware call; it also matches an already-migrated createCacheMiddleware({ store: createInMemoryCacheStore({ maxEntries }) }), which needs no change."
    detection:
      glob: "**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}"
      matches:
        - '\bcreateCacheMiddleware\s*\(\s*\{[^}]*\b(maxEntries|clock)\s*:'
  - id: cache-store-object-arguments
    summary: "A custom CacheStore implements set({ key, meta, entry }) instead of set(key, entry, ttlMs), and a new required unset({ keys, meta }). CachedEntry has no storedAt."
    detection:
      glob: "**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}"
      matches:
        - '\bCacheStore\b'
        - '\bCachedEntry\b'
        - '\bcreateCacheMiddleware\s*\('
---

## `cache-annotation-ttl-removed`

The read annotation no longer carries a lifetime. The store decides how long an entry lives. The default store, which `createCacheMiddleware()` uses when you pass no `store`, keeps every entry for 60 seconds.

This also changes behaviour without a type error. Before, a read annotated without `ttl` (`cacheAnnotation({})`, `cacheAnnotation({ key })`, or a `ttl` that evaluated to `undefined`) was not cached. Now every annotated read in runtime scope is cached. If a read must stay uncached, remove its annotation, or pass `cacheAnnotation({ bypass: true })`.

In each file that calls `cacheAnnotation(...)`:

1. Remove the `ttl` property. `cacheAnnotation({ ttl: 60_000 })` becomes `cacheAnnotation({})`, and `cacheAnnotation({ ttl, key })` becomes `cacheAnnotation({ key })`.
2. Remove any variable, function parameter or option field that existed only to supply that `ttl` (for example a `ttlMs` option on a helper that wraps the annotated read), and remove it from its callers.
3. If every read used the same lifetime and it was not 60 seconds, set it once on the store: `createCacheMiddleware({ store: createInMemoryCacheStore({ ttlMs }) })`. `ttlMs: Infinity` never expires. If reads need different lifetimes, write a custom `CacheStore` that reads the lifetime from the annotation's `meta` (see `cache-store-object-arguments`), and pass it as `cacheAnnotation({ meta: { ttlMs } })`.
4. Update comments and READMEs that say the annotation needs a `ttl`, that caching happens "within the TTL window" of the annotation, or that an annotation without `ttl` passes through. Say instead that an annotated read is cached and the default store keeps the entry for 60 seconds.

Before:

```ts
export async function getUsersCached(limit = 10, ttlMs = 60_000) {
  const plan = db.sql.public.user
    .select('id', 'email')
    .annotate(cacheAnnotation({ ttl: ttlMs }))
    .limit(limit)
    .build();
  return db.runtime().query(plan);
}
```

After:

```ts
export async function getUsersCached(limit = 10) {
  const plan = db.sql.public.user
    .select('id', 'email')
    .annotate(cacheAnnotation({}))
    .limit(limit)
    .build();
  return db.runtime().query(plan);
}
```

## `cache-annotation-skip-renamed-bypass`

In each file that imports from `@prisma/orm-extension-middleware-cache`:

1. Rename `skip` to `bypass` in every `cacheAnnotation(...)` argument: `cacheAnnotation({ skip: forceRefresh })` becomes `cacheAnnotation({ bypass: forceRefresh })`. Only rename `skip` inside a `cacheAnnotation` argument or a value typed `CachePayload`; leave other `skip` properties alone.
2. Rename the type `CachePayload` to `CacheAnnotationOptions`, in imports and in uses.
3. Update comments that describe `skip` on the annotation, or that say `skip` wins over a `ttl`.

## `cache-middleware-store-options`

In each call to `createCacheMiddleware(...)`:

- If the options contain only `maxEntries: 1000` (or `1_000`), and no `clock`, call `createCacheMiddleware()` with no options.
- Otherwise, move `maxEntries` and `clock` to a store: `createCacheMiddleware({ maxEntries: 500 })` becomes `createCacheMiddleware({ store: createInMemoryCacheStore({ maxEntries: 500 }) })`, importing `createInMemoryCacheStore` from `@prisma/orm-extension-middleware-cache`. The middleware's `clock` used to stamp `storedAt` only; it now drives the store's expiry.

`createInMemoryCacheStore` options are all optional now: `maxEntries` (default 1000), `ttlMs` (default 60 000) and `clock` (default `Date.now`).

## `cache-store-object-arguments`

Only for code that implements `CacheStore`, as a typed object, a class, or an object literal passed inline to `createCacheMiddleware({ store: { ... } })`. The types reject the old shape, but an untyped JavaScript store fails only at run time, so check each one.

1. Change `set(key, entry, ttlMs)` to `set({ key, meta, entry })`. `meta` is the read annotation's `meta`, or `undefined`. There is no `ttlMs` argument: the store sets the lifetime itself, as a fixed value or read from `meta`.
2. Add `unset({ keys, meta })`. It must remove the entries stored under `keys` when `keys` is not `undefined`. When `meta` is not `undefined`, it must remove the entries whose `meta` matches, compared by value; a store that does not index `meta` must throw instead of ignoring it.
3. Stop reading or writing `storedAt` on `CachedEntry`; an entry is `{ rows }`.
4. When `set` resolves, the entry must already be visible to an `unset` of the same key: do not resolve `set` before the write has landed.

Before:

```ts
const store: CacheStore = {
  async get(key) {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as CachedEntry) : undefined;
  },
  async set(key, entry, ttlMs) {
    await redis.set(key, JSON.stringify(entry), 'PX', ttlMs);
  },
};
```

After:

```ts
const store: CacheStore = {
  async get(key) {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as CachedEntry) : undefined;
  },
  async set({ key, entry }) {
    await redis.set(key, JSON.stringify(entry), 'PX', 60_000);
  },
  async unset({ keys, meta }) {
    if (meta !== undefined) {
      throw new Error('This store does not index meta');
    }
    if (keys !== undefined && keys.length > 0) {
      await redis.del(...keys);
    }
  },
};
```
