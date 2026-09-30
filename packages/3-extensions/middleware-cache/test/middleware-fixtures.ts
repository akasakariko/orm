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

export function spyStore() {
  const inner = new Map<string, CachedEntry>();
  const getSpy = vi.fn(async (key: string) => inner.get(key));
  const setSpy = vi.fn(async (target: Parameters<CacheStore['set']>[0]) => {
    inner.set(target.key, target.entry);
  });
  const unsetSpy = vi.fn(async (target: Parameters<CacheStore['unset']>[0]) => {
    for (const key of target.keys ?? []) {
      inner.delete(key);
    }
  });
  const store: CacheStore = { get: getSpy, set: setSpy, unset: unsetSpy };
  return { ...store, getSpy, setSpy, unsetSpy, inner };
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
