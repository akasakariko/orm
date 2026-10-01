import type { PlanMeta } from '@internal/contract/types';
import type {
  CrossFamilyMiddleware,
  ExecutionPlan,
  RuntimeMiddlewareContext,
} from '@internal/framework-components/runtime';
import { vi } from 'vitest';
import type { CachedEntry, CacheStore } from '../src/cache-store';

export interface MockExec extends ExecutionPlan {
  readonly statement: string;
}

export const baseMeta: PlanMeta = {
  target: 'postgres',
  targetFamily: 'sql',
  storageHash: 'test',
  lane: 'orm',
};

export function makeExec(statement: string, annotations?: Record<string, unknown>): MockExec {
  return Object.freeze({
    statement,
    meta: annotations ? { ...baseMeta, annotations } : baseMeta,
  });
}

export function makeCtx(overrides?: Partial<RuntimeMiddlewareContext>): RuntimeMiddlewareContext {
  return {
    contract: {},
    mode: 'strict',
    now: () => Date.now(),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    contentHash: async (exec) => `key:${(exec as MockExec).statement}`,
    scope: 'runtime',
    planExecutionId: 'test-fixture-plan-execution-id',
    ...overrides,
  };
}

/**
 * A versioned in-memory store for middleware tests. It records a version for every key it is asked
 * about. `unset` bumps the version of every key it names and, when given `meta`, of every recorded
 * key `matchesMeta` accepts, whether or not the key holds an entry.
 */
export function spyStore(options?: {
  readonly matchesMeta?: (key: string, meta: unknown) => boolean;
}) {
  const inner = new Map<string, CachedEntry>();
  const versions = new Map<string, number>();
  const versionOf = (key: string) => versions.get(key) ?? 0;
  const bump = (key: string) => {
    versions.set(key, versionOf(key) + 1);
    inner.delete(key);
  };
  const getSpy = vi.fn(async (key: string) => {
    versions.set(key, versionOf(key));
    return { entry: inner.get(key), version: versionOf(key) };
  });
  const setSpy = vi.fn(async (target: Parameters<CacheStore['set']>[0]) => {
    if (target.version !== undefined && target.version !== versionOf(target.key)) {
      return false;
    }
    inner.set(target.key, target.entry);
    return true;
  });
  const unsetSpy = vi.fn(async (target: Parameters<CacheStore['unset']>[0]) => {
    for (const key of target.keys ?? []) {
      bump(key);
    }
    const matchesMeta = options?.matchesMeta;
    if (target.meta !== undefined && matchesMeta !== undefined) {
      for (const key of new Set([...inner.keys(), ...versions.keys()])) {
        if (matchesMeta(key, target.meta)) {
          bump(key);
        }
      }
    }
  });
  const store: CacheStore = { get: getSpy, set: setSpy, unset: unsetSpy };
  return { ...store, getSpy, setSpy, unsetSpy, inner, versions };
}

export async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

export async function runMiss(
  mw: CrossFamilyMiddleware,
  exec: ExecutionPlan,
  ctx: RuntimeMiddlewareContext,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  await mw.interceptQuery?.(exec, ctx);
  for (const row of rows) {
    await mw.onRow?.(row, exec, ctx);
  }
  await mw.afterQuery?.(
    exec,
    { rowCount: rows.length, latencyMs: 0, completed: true, source: 'driver' },
    ctx,
  );
}
