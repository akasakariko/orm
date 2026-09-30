import type {
  AfterQueryResult,
  CrossFamilyMiddleware,
  ExecutionPlan,
  RuntimeMiddlewareContext,
} from '@internal/framework-components/runtime';
import { ifDefined } from '@internal/utils/defined';
import { structuredError } from '@internal/utils/structured-error';
import { type CachePayload, cacheAnnotation } from './cache-annotation';
import { type CacheStore, createInMemoryCacheStore } from './cache-store';

/**
 * Options accepted by `createCacheMiddleware`.
 *
 * - `store` — pluggable cache backend. Defaults to an in-process LRU
 *   produced by `createInMemoryCacheStore`. Users supply Redis,
 *   Memcached, or any other backend by implementing the `CacheStore`
 *   interface.
 * - `maxEntries` — only consulted when `store` is omitted. Sets the
 *   `maxEntries` cap on the default in-memory store. Defaults to 1000.
 * - `clock` — injectable time source for `storedAt` stamping on
 *   committed entries. Defaults to `Date.now`. Tests inject a controlled
 *   clock to make commit-time observable. Note: TTL math lives inside
 *   the store, not the middleware — supplying a clock here only affects
 *   the `storedAt` field on committed `CachedEntry` values.
 * - `defaultTtlMs` — TTL for annotated reads whose annotation has no `ttl`. When unset, such
 *   reads pass through uncached.
 * - `deriveKey` — computes the cache key of a cached read whose annotation has no `key`.
 *   Defaults to `deriveKeyFromContentHash`. It runs on every such read, hit or miss, and an
 *   error from it fails the read. It must return different keys whenever the rows can differ;
 *   build on `deriveKeyFromContentHash` to keep the statement, parameters and storage hash.
 */
export interface CacheMiddlewareOptions {
  readonly store?: CacheStore;
  readonly maxEntries?: number;
  readonly clock?: () => number;
  readonly defaultTtlMs?: number;
  readonly deriveKey?: (
    exec: ExecutionPlan,
    ctx: RuntimeMiddlewareContext,
  ) => string | Promise<string>;
}

/**
 * The cache middleware.
 *
 * `invalidate` makes every read that missed before it was called skip storing its rows, then
 * removes entries:
 *
 * - `invalidate({ keys })` calls the store's `delete` for each key, in order. It throws
 *   `RUNTIME.CACHE_STORE_CANNOT_INVALIDATE` before anything else when the store has no `delete`,
 *   even for empty `keys`; otherwise empty `keys` do nothing.
 * - `invalidate(run)` awaits `run`, which deletes through a store reference the caller holds. It
 *   performs no capability check.
 *
 * A rejection from the store or from `run` propagates; entries already removed stay removed.
 */
export type CacheMiddleware = CrossFamilyMiddleware & {
  invalidate(target: { readonly keys: readonly string[] }): Promise<void>;
  invalidate(run: () => Promise<void>): Promise<void>;
};

/**
 * The default `deriveKey`: the family runtime's content hash of the plan, which covers the
 * statement, its parameters and the storage hash.
 */
export function deriveKeyFromContentHash(
  exec: ExecutionPlan,
  ctx: RuntimeMiddlewareContext,
): Promise<string> {
  return ctx.contentHash(exec);
}

/**
 * Per-execution buffer correlated with the post-lowering `exec` object
 * via a private `WeakMap`. Each in-flight cache miss owns one of these.
 *
 * The plan-identity invariant required by this `WeakMap` correlation is
 * documented in the runtime subsystem doc and pinned by a regression
 * test: family runtimes produce a fresh, frozen `exec` per call (SQL
 * `prepareExecution` constructs `Object.freeze({...lowered, ...})` on each
 * invocation; Mongo lowers fresh per call). If a future plan-
 * memoization change ever recycles `exec` objects across calls, this
 * correlation would silently leak rows between concurrent executions
 * — which is exactly what the regression test catches.
 */
interface PendingMiss {
  readonly key: string;
  readonly ttlMs: number;
  readonly attributes: unknown;
  readonly invalidations: number;
  readonly buffer: Record<string, unknown>[];
}

/**
 * Default `maxEntries` for the built-in in-memory store. Bounded so a
 * runaway producer cannot exhaust process memory; users who need
 * different bounds supply a custom `CacheStore`.
 */
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * Reads the cache payload from the plan, if present and branded.
 *
 * Returns `undefined` when:
 * - the plan has no `meta.annotations`, or
 * - the `cache` namespace key is absent, or
 * - the value under `cache` is not a branded `AnnotationValue` (the
 *   `cacheAnnotation.read` defensive check covers this).
 */
function readCachePayload(plan: ExecutionPlan): CachePayload | undefined {
  return cacheAnnotation.read(plan);
}

function cannotInvalidate(missingMethod: 'delete') {
  return structuredError(
    'RUNTIME.CACHE_STORE_CANNOT_INVALIDATE',
    `The cache store cannot invalidate entries by key because it has no ${missingMethod} method`,
    {
      fix: `Supply a CacheStore that implements ${missingMethod}.`,
      meta: { missingMethod },
    },
  );
}

/**
 * Creates a family-agnostic caching middleware.
 *
 * The middleware uses three hooks:
 *
 * - `interceptQuery` — on each execution, checks the cache. On a hit, returns
 *   the cached raw rows; the runtime skips `runDriver` and `onRow`
 *   (`beforeQuery` is not affected — it has already run for every
 *   middleware before any `interceptQuery` is consulted) and yields the
 *   cached rows to the consumer (which, in the SQL runtime, sees them
 *   after the standard `decodeRow` pass — i.e. the cache stores
 *   wire-format values). On a miss, records a pending buffer keyed on
 *   the `exec` object identity and returns `undefined` (passthrough).
 * - `onRow` — on the miss path, appends each row yielded by the driver
 *   to the pending buffer.
 * - `afterQuery` — on the miss path, commits the buffer to the store
 *   if and only if `result.completed === true && result.source === 'driver'`.
 *   Failed executions and middleware-served executions never populate
 *   the cache. The pending buffer is cleared in all branches so a stale
 *   `WeakMap` entry cannot leak between executions sharing an `exec`.
 *
 * The middleware bypasses the cache entirely when:
 * - the plan has no `cache` annotation, or
 * - the annotation has `skip: true`, or
 * - the annotation has no `ttl` and no `defaultTtlMs` is set, or
 * - `ctx.scope !== 'runtime'` (connection / transaction scopes opt out).
 *
 * Returns a cross-family `RuntimeMiddleware` (no `familyId` / `targetId`) with an `invalidate`
 * method. The package depends on no SQL or Mongo package; the default cache key is
 * `ctx.contentHash(exec)`, populated by the family runtime, so SQL and Mongo runtimes both work
 * out of the box.
 *
 * @example
 * ```typescript
 * import { createCacheMiddleware, cacheAnnotation } from '@internal/middleware-cache';
 *
 * const db = postgres({
 *   contractJson,
 *   url: process.env['DATABASE_URL']!,
 *   middleware: [createCacheMiddleware({ maxEntries: 1000 })],
 * });
 *
 * const user = await db.orm.public.User.first(
 *   { id },
 *   (meta) => meta.annotate(cacheAnnotation({ ttl: 60_000 })),
 * );
 * ```
 */
export function createCacheMiddleware(options?: CacheMiddlewareOptions): CacheMiddleware {
  const store =
    options?.store ??
    createInMemoryCacheStore({
      maxEntries: options?.maxEntries ?? DEFAULT_MAX_ENTRIES,
    });
  const clock = options?.clock ?? Date.now;
  const defaultTtlMs = options?.defaultTtlMs;
  const deriveKey = options?.deriveKey ?? deriveKeyFromContentHash;
  let invalidations = 0;

  // Per-execution scratch space, keyed on the post-lowering `exec`
  // object identity. WeakMap keeps cleanup automatic: if an execution is
  // dropped without `afterQuery` firing (e.g. an early throw before
  // the middleware lifecycle starts), the entry is GC'd alongside the exec
  // object.
  const pending = new WeakMap<object, PendingMiss>();

  async function interceptQuery(
    exec: ExecutionPlan,
    ctx: RuntimeMiddlewareContext,
  ): Promise<{ readonly rows: Iterable<Record<string, unknown>> } | undefined> {
    if (ctx.scope !== 'runtime') {
      return undefined;
    }

    const payload = readCachePayload(exec);
    if (payload === undefined) {
      return undefined;
    }
    if (payload.skip === true) {
      return undefined;
    }
    const ttlMs = payload.ttl ?? defaultTtlMs;
    if (ttlMs === undefined) {
      return undefined;
    }

    const key = payload.key ?? (await deriveKey(exec, ctx));
    const hit = await store.get(key);
    if (hit !== undefined) {
      ctx.log.debug?.({ event: 'middleware.cache.hit', middleware: 'cache', key });
      // Hit path leaves no WeakMap entry — afterQuery's lookup will
      // return undefined and short-circuit.
      return { rows: hit.rows };
    }

    // Miss: record the pending buffer so onRow / afterExecute can
    // commit on success. The TTL is captured here so a later mutation
    // of the annotation (defensive) cannot change the commit window.
    pending.set(exec, { key, ttlMs, attributes: payload.attributes, invalidations, buffer: [] });
    ctx.log.debug?.({ event: 'middleware.cache.miss', middleware: 'cache', key });
    return undefined;
  }

  async function onRow(
    row: Record<string, unknown>,
    exec: ExecutionPlan,
    _ctx: RuntimeMiddlewareContext,
  ): Promise<void> {
    const slot = pending.get(exec);
    if (slot === undefined) {
      return;
    }
    slot.buffer.push(row);
  }

  async function afterQuery(
    exec: ExecutionPlan,
    result: AfterQueryResult,
    ctx: RuntimeMiddlewareContext,
  ): Promise<void> {
    const slot = pending.get(exec);
    if (slot === undefined) {
      return;
    }
    // Always release the WeakMap entry — the exec is single-use and
    // any state we leave behind is dead weight on the GC.
    pending.delete(exec);

    if (!result.completed || result.source !== 'driver') {
      return;
    }

    const logSkipped = () =>
      ctx.log.debug?.({
        event: 'middleware.cache.store-skipped',
        middleware: 'cache',
        key: slot.key,
      });

    if (slot.invalidations !== invalidations) {
      logSkipped();
      return;
    }

    await store.set(
      slot.key,
      { rows: slot.buffer, storedAt: clock(), ...ifDefined('attributes', slot.attributes) },
      slot.ttlMs,
    );

    if (slot.invalidations !== invalidations) {
      await store.delete?.(slot.key);
      logSkipped();
      return;
    }
    ctx.log.debug?.({ event: 'middleware.cache.store', middleware: 'cache', key: slot.key });
  }

  async function invalidate(
    target: { readonly keys: readonly string[] } | (() => Promise<void>),
  ): Promise<void> {
    if (typeof target === 'function') {
      invalidations += 1;
      await target();
      return;
    }
    const deleteKey = store.delete;
    if (deleteKey === undefined) {
      throw cannotInvalidate('delete');
    }
    const { keys } = target;
    if (keys.length === 0) {
      return;
    }

    invalidations += 1;
    for (const key of keys) {
      await deleteKey.call(store, key);
    }
  }

  return {
    name: 'cache',
    interceptQuery,
    onRow,
    afterQuery,
    invalidate,
  };
}
