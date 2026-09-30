import { defineAnnotation } from '@internal/framework-components/runtime';

/**
 * Payload accepted when calling the `cacheAnnotation` handle.
 *
 * - `ttl` — Time-to-live for the cached entry, in milliseconds. When omitted, the middleware's
 *   `defaultTtlMs` applies; when that is also unset, the cache middleware passes the query through
 *   untouched — presence of the annotation alone is not sufficient to enable caching. This makes
 *   the cache strictly opt-in per query.
 * - `skip` — When `true`, the cache middleware passes the query through
 *   untouched even if a `ttl` is set. Useful for selectively bypassing
 *   the cache on a per-call basis without removing the annotation
 *   entirely (e.g. a "force refresh" knob in user code).
 * - `key` — Per-query cache key. When supplied, the middleware uses it as-is and does not call
 *   its `deriveKey`, so any prefix `deriveKey` adds must be part of this string. It is not
 *   rehashed: keep it bounded in size and free of data you do not want in logs or store dumps.
 * - `attributes` — Any value, copied by reference onto the stored `CachedEntry`. The middleware
 *   never reads it; extensions and `InMemoryCacheStore.deleteWhere` do. Do not mutate it after
 *   the read, and keep it serialisable if the store serialises entries.
 */
export interface CachePayload {
  readonly ttl?: number;
  readonly skip?: boolean;
  readonly key?: string;
  readonly attributes?: unknown;
}

/**
 * Read-only annotation handle for the cache middleware.
 *
 * Declared with `applicableTo: ['read']`. Write terminals supply
 * `K = 'write'` to the type-level `ValidAnnotations<'write', As>` gate
 * (and the runtime `assertAnnotationsApplicable(annotations, 'write', ...)`
 * check); the join `K extends Kinds` fails for this annotation, making
 * "cache a mutation" structurally impossible without an `as any` cast
 * bypass at both type *and* runtime levels.
 *
 * Stored under namespace `'cache'` in `plan.meta.annotations`. The cache
 * middleware reads it via `cacheAnnotation.read(plan)`.
 *
 * @example
 * ```typescript
 * import { cacheAnnotation } from '@internal/middleware-cache';
 *
 * // ORM read terminal — accepts the read-only annotation via the meta callback.
 * const user = await db.orm.public.User.first(
 *   { id },
 *   (meta) => meta.annotate(cacheAnnotation({ ttl: 60_000 })),
 * );
 *
 * // SQL DSL select builder — chainable.
 * const plan = db.sql
 *   .from(tables.user)
 *   .annotate(cacheAnnotation({ ttl: 60_000 }))
 *   .select({ id: tables.user.columns.id })
 *   .build();
 * ```
 */
export const cacheAnnotation = defineAnnotation<CachePayload>()({
  namespace: 'cache',
  applicableTo: ['read'],
});
