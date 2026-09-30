import { defineAnnotation } from '@internal/framework-components/runtime';

/**
 * Options for a read annotated with `cacheAnnotation`. A read with the annotation, in runtime scope
 * and not bypassed, is cached; how long the entry lives is the store's policy.
 *
 * - `key` — the entry's key. When absent, the middleware's `deriveKey` computes it. The key is
 *   stored and logged as given, so keep it bounded and free of secrets.
 * - `meta` — any value, passed by reference to the store's `set` with the entry. The middleware
 *   never reads it. Stores use it to group entries (for example by tag) or to set a lifetime.
 * - `bypass` — when `true`, the read neither reads from nor writes to the cache.
 */
export interface CacheAnnotationOptions {
  readonly key?: string;
  readonly meta?: unknown;
  readonly bypass?: boolean;
}

/**
 * Marks a read for the cache middleware. It applies to reads only: a write terminal refuses it at
 * compile time and at run time. The middleware reads it from `plan.meta.annotations.cache`.
 *
 * @example
 * ```typescript
 * import { cacheAnnotation } from '@internal/middleware-cache';
 *
 * // ORM read terminal — accepts the read-only annotation via the meta callback.
 * const user = await db.orm.public.User.first(
 *   { id },
 *   (meta) => meta.annotate(cacheAnnotation({ key: `user-${id}` })),
 * );
 *
 * // SQL DSL select builder — chainable.
 * const plan = db.sql
 *   .from(tables.user)
 *   .annotate(cacheAnnotation({}))
 *   .select({ id: tables.user.columns.id })
 *   .build();
 * ```
 */
export const cacheAnnotation = defineAnnotation<CacheAnnotationOptions>()({
  namespace: 'cache',
  applicableTo: ['read'],
});
