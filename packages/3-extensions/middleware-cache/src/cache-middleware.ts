import type {
  AfterQueryResult,
  CrossFamilyMiddleware,
  ExecutionPlan,
  RuntimeMiddlewareContext,
} from '@internal/framework-components/runtime';
import { cacheAnnotation } from './cache-annotation';
import { type CacheStore, createInMemoryCacheStore } from './cache-store';

/**
 * Options accepted by `createCacheMiddleware`.
 *
 * - `store` — the cache backend. Defaults to `createInMemoryCacheStore()`: 1000 entries, 60 s.
 * - `deriveKey` — computes the key of a cached read whose annotation has no `key`. Defaults to
 *   `deriveKeyFromContentHash`. It runs on every such read, hit or miss, and an error from it
 *   fails the read. It must return different keys whenever the rows can differ; build on
 *   `deriveKeyFromContentHash` to keep the statement, parameters and storage hash.
 */
export interface CacheMiddlewareOptions {
  readonly store?: CacheStore;
  readonly deriveKey?: (
    exec: ExecutionPlan,
    ctx: RuntimeMiddlewareContext,
  ) => string | Promise<string>;
}

/**
 * The cache middleware.
 *
 * `invalidate` removes entries through one `store.unset({ keys, meta })` call. It does nothing
 * when `keys` is empty or absent and `meta` is absent. Before calling the store it marks reads in
 * flight as stale so they skip storing their rows: reads for the named `keys`, and every read when
 * `meta` is given, because only the store knows which entries `meta` matches. This guard covers
 * reads in the same process only. An error from the store propagates.
 */
export type CacheMiddleware = CrossFamilyMiddleware & {
  readonly invalidate: (target: {
    readonly keys?: readonly string[];
    readonly meta?: unknown;
  }) => Promise<void>;
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

interface KeyGeneration {
  generation: number;
  pendingMisses: number;
}

/**
 * A cache miss in flight, keyed on the post-lowering `exec` object in a `WeakMap`. Family runtimes
 * build a fresh `exec` per call; the runtime subsystem doc records that invariant.
 */
interface PendingMiss {
  readonly key: string;
  readonly meta: unknown;
  readonly buffer: Record<string, unknown>[];
  readonly globalGeneration: number;
  readonly keyGeneration: number;
  readonly keyState: KeyGeneration;
}

/**
 * Creates a read-through cache middleware that works with every family runtime.
 *
 * It caches a read when the plan carries `cacheAnnotation`, the annotation does not set
 * `bypass`, and the read runs in runtime scope (not inside a connection or transaction). The key
 * is the annotation's `key`, else `deriveKey(exec, ctx)`.
 *
 * - `interceptQuery` — on a hit, returns the stored rows and the driver does not run. On a miss,
 *   starts collecting rows.
 * - `onRow` — collects each row of a miss.
 * - `afterQuery` — stores the rows with `store.set` when the driver completed the read and no
 *   overlapping `invalidate` made it stale. If an `invalidate` made it stale while `set` was in
 *   flight, it removes the key again with `store.unset`.
 *
 * @example
 * ```typescript
 * const cache = createCacheMiddleware();
 * const db = postgres<Contract>({ contractJson, url, middleware: [cache] });
 *
 * const user = await db.orm.public.User.first(
 *   { id: 1 },
 *   (meta) => meta.annotate(cacheAnnotation({ key: 'user-1' })),
 * );
 * await db.orm.public.User.where({ id: 1 }).update({ name: 'Alicia' });
 * await cache.invalidate({ keys: ['user-1'] });
 * ```
 */
export function createCacheMiddleware(options?: CacheMiddlewareOptions): CacheMiddleware {
  const store = options?.store ?? createInMemoryCacheStore();
  const deriveKey = options?.deriveKey ?? deriveKeyFromContentHash;
  let globalGeneration = 0;
  const keyGenerations = new Map<string, KeyGeneration>();
  const pending = new WeakMap<object, PendingMiss>();

  function startMiss(key: string, meta: unknown): PendingMiss {
    const keyState = keyGenerations.get(key) ?? { generation: 0, pendingMisses: 0 };
    keyGenerations.set(key, keyState);
    keyState.pendingMisses += 1;
    return {
      key,
      meta,
      buffer: [],
      globalGeneration,
      keyGeneration: keyState.generation,
      keyState,
    };
  }

  function releaseMiss(miss: PendingMiss): void {
    miss.keyState.pendingMisses -= 1;
    if (miss.keyState.pendingMisses === 0) {
      keyGenerations.delete(miss.key);
    }
  }

  function isStale(miss: PendingMiss): boolean {
    return (
      miss.globalGeneration !== globalGeneration || miss.keyGeneration !== miss.keyState.generation
    );
  }

  async function interceptQuery(
    exec: ExecutionPlan,
    ctx: RuntimeMiddlewareContext,
  ): Promise<{ readonly rows: Iterable<Record<string, unknown>> } | undefined> {
    if (ctx.scope !== 'runtime') {
      return undefined;
    }
    const annotation = cacheAnnotation.read(exec);
    if (annotation === undefined || annotation.bypass === true) {
      return undefined;
    }

    const key = annotation.key ?? (await deriveKey(exec, ctx));
    const hit = await store.get(key);
    if (hit !== undefined) {
      ctx.log.debug?.({ event: 'middleware.cache.hit', middleware: 'cache', key });
      return { rows: hit.rows };
    }

    pending.set(exec, startMiss(key, annotation.meta));
    ctx.log.debug?.({ event: 'middleware.cache.miss', middleware: 'cache', key });
    return undefined;
  }

  async function onRow(
    row: Record<string, unknown>,
    exec: ExecutionPlan,
    _ctx: RuntimeMiddlewareContext,
  ): Promise<void> {
    pending.get(exec)?.buffer.push(row);
  }

  async function storeMiss(
    miss: PendingMiss,
    result: AfterQueryResult,
    ctx: RuntimeMiddlewareContext,
  ): Promise<void> {
    if (!result.completed || result.source !== 'driver') {
      return;
    }
    const logSkipped = () =>
      ctx.log.debug?.({
        event: 'middleware.cache.store-skipped',
        middleware: 'cache',
        key: miss.key,
      });

    if (isStale(miss)) {
      logSkipped();
      return;
    }
    await store.set({ key: miss.key, meta: miss.meta, entry: { rows: miss.buffer } });
    if (isStale(miss)) {
      await store.unset({ keys: [miss.key], meta: undefined });
      logSkipped();
      return;
    }
    ctx.log.debug?.({ event: 'middleware.cache.store', middleware: 'cache', key: miss.key });
  }

  async function afterQuery(
    exec: ExecutionPlan,
    result: AfterQueryResult,
    ctx: RuntimeMiddlewareContext,
  ): Promise<void> {
    const miss = pending.get(exec);
    if (miss === undefined) {
      return;
    }
    pending.delete(exec);
    try {
      await storeMiss(miss, result, ctx);
    } finally {
      releaseMiss(miss);
    }
  }

  async function invalidate(target: {
    readonly keys?: readonly string[];
    readonly meta?: unknown;
  }): Promise<void> {
    const keys = target.keys ?? [];
    if (keys.length === 0 && target.meta === undefined) {
      return;
    }
    for (const key of keys) {
      const keyState = keyGenerations.get(key);
      if (keyState !== undefined) {
        keyState.generation += 1;
      }
    }
    if (target.meta !== undefined) {
      globalGeneration += 1;
    }
    await store.unset({ keys: target.keys, meta: target.meta });
  }

  return { name: 'cache', interceptQuery, onRow, afterQuery, invalidate };
}
