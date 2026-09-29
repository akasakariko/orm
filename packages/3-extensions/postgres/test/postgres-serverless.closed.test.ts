import { validateSqlContractFully } from '@internal/sql-contract/validators';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contract } from './fixtures/generated/contract';
import fixtureContractJson from './fixtures/generated/contract.json' with { type: 'json' };

/**
 * A query, transaction or statement returned from an `await using` scope without `await` runs
 * after the connection has closed. It rejects once, with the runtime's closed error, and the
 * rejection reaches only the caller: Node never reports an unhandled rejection.
 */

const recorded = vi.hoisted(() => ({
  calls: [] as string[],
}));

// Only mock the third-party pg boundary. Real drivers, adapters, and runtimes run over this fake
// client. `end` takes a macrotask, as the real socket does, so the scope's disposal is still
// waiting when an unawaited promise would reject.
vi.mock('pg', () => {
  class Client {
    on = vi.fn().mockReturnThis();
    connect = vi.fn().mockResolvedValue(undefined);
    query = vi.fn(async () => {
      recorded.calls.push('query');
      return { rows: [], rowCount: 0 };
    });
    end = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          recorded.calls.push('end');
          setTimeout(resolve, 0);
        }),
    );
  }

  return { Client, Pool: class {} };
});

import postgresServerless from '../src/runtime/postgres-serverless';

const fixtureContract = validateSqlContractFully<Contract>(fixtureContractJson);
const url = 'postgres://localhost:5432/db';

const runtimeClosedError = {
  code: 'DRIVER.NOT_CONNECTED',
  message: 'Runtime is closed',
  why: 'close() was called on this runtime, or the await using scope that held it has ended.',
  fix: expect.stringContaining('await using'),
};

const unhandledRejections: unknown[] = [];
const recordUnhandledRejection = (reason: unknown): void => {
  unhandledRejections.push(reason);
};

beforeEach(() => {
  recorded.calls.length = 0;
  unhandledRejections.length = 0;
  process.on('unhandledRejection', recordUnhandledRejection);
});

afterEach(() => {
  process.off('unhandledRejection', recordUnhandledRejection);
});

type Connection = Awaited<ReturnType<ReturnType<typeof postgresServerless<Contract>>['connect']>>;

const unawaitedReturns: ReadonlyArray<[string, (db: Connection) => PromiseLike<unknown>]> = [
  ['db.orm.public.User.all()', (db) => db.orm.public.User.all()],
  ['db.orm.public.User.first()', (db) => db.orm.public.User.first()],
  [
    'db.runtime().query(plan)',
    (db) => db.runtime().query(db.sql.public.users.select('id').build()),
  ],
  [
    'db.runtime().execute(plan)',
    (db) =>
      db.runtime().execute(
        db.sql.public.users
          .update({ name: 'probe' })
          .where((f, fns) => fns.eq(f.id, 1))
          .build(),
      ),
  ],
  [
    'db.transaction(fn)',
    (db) => db.transaction(async (tx) => (await tx.orm.public.User.all()).length),
  ],
];

const variants: ReadonlyArray<[string, { verifyMarker: boolean; warm: boolean }]> = [
  ['the first query on the connection', { verifyMarker: true, warm: false }],
  ['verifyMarker: false', { verifyMarker: false, warm: false }],
  ['an earlier awaited query on the connection', { verifyMarker: true, warm: true }],
];

describe('a promise returned from an await using scope without await', () => {
  describe.each(variants)('with %s', (_variant, { verifyMarker, warm }) => {
    const serverless = postgresServerless<Contract>({
      contractJson: fixtureContract,
      ...(verifyMarker ? {} : { verifyMarker: false }),
    });

    async function returnWithoutAwait(run: (db: Connection) => PromiseLike<unknown>) {
      await using db = await serverless.connect({ url });
      if (warm) await db.orm.public.User.first();
      return run(db);
    }

    it.each(unawaitedReturns)(
      '%s rejects once with the runtime closed error and reaches no unhandled rejection',
      async (_name, run) => {
        const outcome = await returnWithoutAwait(run).then(
          (value) => ({ resolved: value }),
          (reason: unknown) => ({ rejected: reason }),
        );

        expect.soft(unhandledRejections).toEqual([]);
        expect.soft(outcome).toEqual({ rejected: expect.objectContaining(runtimeClosedError) });
        expect(recorded.calls.filter((call) => call === 'end')).toHaveLength(1);
        expect(recorded.calls.slice(recorded.calls.indexOf('end'))).toEqual(['end']);
      },
    );
  });
});
