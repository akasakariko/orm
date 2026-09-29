import type { SqlStorage } from '@internal/sql-contract/types';
import { validateSqlContractFully } from '@internal/sql-contract/validators';
import { createContract } from '@repo/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contract } from './fixtures/generated/contract';
import fixtureContractJson from './fixtures/generated/contract.json' with { type: 'json' };

// Only mock the third-party pg boundary. Real drivers, adapters, and runtimes
// run over this fake pool/client.
vi.mock('pg', () => {
  const poolEndSpy = vi.fn().mockResolvedValue(undefined);
  const querySpy = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const releaseSpy = vi.fn();

  const connectSpy = vi.fn().mockResolvedValue({
    query: querySpy,
    release: releaseSpy,
  });

  class Pool {
    on = vi.fn().mockReturnThis();
    static readonly _endSpy = poolEndSpy;
    static readonly _connectSpy = connectSpy;
    readonly _options: unknown;

    constructor(options: unknown) {
      this._options = options;
    }

    connect = connectSpy;
    end = poolEndSpy;
    totalCount = 0;
    idleCount = 0;
    waitingCount = 0;
  }

  class Client {
    on = vi.fn().mockReturnThis();
    connect = vi.fn().mockResolvedValue(undefined);
    query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    end = vi.fn().mockResolvedValue(undefined);
    release = vi.fn();
    escapeIdentifier = vi.fn();
    escapeLiteral = vi.fn();
  }

  return { Pool, Client };
});

import { Client, Pool } from 'pg';
import postgres from '../src/runtime/postgres';

const contract = createContract<SqlStorage>();
const fixtureContract = validateSqlContractFully<Contract>(fixtureContractJson);

const runtimeClosedError = {
  code: 'DRIVER.NOT_CONNECTED',
  message: 'Runtime is closed',
};

function poolEndSpy() {
  return (Pool as unknown as { _endSpy: ReturnType<typeof vi.fn> })._endSpy;
}

beforeEach(() => {
  vi.clearAllMocks();
  poolEndSpy().mockResolvedValue(undefined);
  (Pool as unknown as { _connectSpy: ReturnType<typeof vi.fn> })._connectSpy.mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  });
});

describe('postgres close()', () => {
  it('releases the facade-owned Pool when constructed from { url }', async () => {
    const db = postgres({ contract, url: 'postgres://localhost:5432/db' });
    db.runtime();
    await Promise.resolve();

    await db.close();

    expect(poolEndSpy()).toHaveBeenCalledTimes(1);
  });

  it('does NOT close a caller-supplied pg.Pool', async () => {
    const pool = new Pool({ connectionString: 'postgres://localhost:5432/db' });
    const ownEndSpy = vi.fn().mockResolvedValue(undefined);
    (pool as unknown as { end: typeof vi.fn }).end = ownEndSpy;

    const db = postgres({ contract, pg: pool });
    db.runtime();
    await db.close();

    expect(ownEndSpy).not.toHaveBeenCalled();
  });

  it('does NOT close a caller-supplied pg.Client', async () => {
    const client = new Client();
    const db = postgres({ contract, pg: client });
    db.runtime();
    await db.close();

    expect(client.end).not.toHaveBeenCalled();
  });

  it('is idempotent: calling twice does not throw and does not double-dispose the owned pool', async () => {
    const db = postgres({ contract, url: 'postgres://localhost:5432/db' });
    db.runtime();
    await Promise.resolve();

    await db.close();
    await db.close();

    expect(poolEndSpy()).toHaveBeenCalledTimes(1);
  });

  it('close() is idempotent even after a failed pool.end()', async () => {
    // A first close() that fails due to pool.end() error must not leave the
    // facade in a state where a second close() tries pool.end() again.
    poolEndSpy().mockRejectedValueOnce(new Error('pool.end failed')).mockResolvedValue(undefined);

    const db = postgres({ contract, url: 'postgres://localhost:5432/db' });
    db.runtime();
    // Wait for background connect setup (ownedDispose) to be wired
    await Promise.resolve();
    await Promise.resolve();

    // First close fails because pool.end() throws
    await expect(db.close()).rejects.toThrow('pool.end failed');

    // Second close is a no-op (already disposed guard)
    await expect(db.close()).resolves.toBeUndefined();
    // pool.end was not called a second time
    expect(poolEndSpy()).toHaveBeenCalledTimes(1);
  });

  it('before any connect is a no-op', async () => {
    const db = postgres({ contract, url: 'postgres://localhost:5432/db' });
    await db.close();
    expect(poolEndSpy()).not.toHaveBeenCalled();
  });

  it('db.runtime() rejects with "Postgres client is closed" after close()', async () => {
    const db = postgres({ contract, url: 'postgres://localhost:5432/db' });
    await db.close();
    expect(() => db.runtime()).toThrow('Postgres client is closed');
  });

  it('db.connect() rejects with "Postgres client is closed" after close()', async () => {
    const db = postgres({ contract, url: 'postgres://localhost:5432/db' });
    await db.close();
    await expect(db.connect()).rejects.toThrow('Postgres client is closed');
  });

  it('await using db executes [Symbol.asyncDispose] on scope exit (pool.end called)', async () => {
    async function run() {
      await using db = postgres({ contract, url: 'postgres://localhost:5432/db' });
      db.runtime();
      await Promise.resolve();
    }

    await run();
    expect(poolEndSpy()).toHaveBeenCalledTimes(1);
  });
});

describe('a promise pending when close() is called on a client that owns its pool', () => {
  const unhandledRejections: unknown[] = [];
  const recordUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };

  beforeEach(() => {
    unhandledRejections.length = 0;
    process.on('unhandledRejection', recordUnhandledRejection);
    // The real pool.end() settles on an I/O turn; a macrotask keeps close() pending while an
    // unawaited promise would reject.
    poolEndSpy().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 0)));
    (Pool as unknown as { _connectSpy: ReturnType<typeof vi.fn> })._connectSpy.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
      on: vi.fn(),
    });
  });

  afterEach(() => {
    process.off('unhandledRejection', recordUnhandledRejection);
  });

  async function connectedClient() {
    const db = postgres<Contract>({
      contractJson: fixtureContract,
      url: 'postgres://localhost:5432/db',
    });
    await db.connect();
    return db;
  }

  async function closeWhilePending(
    db: Awaited<ReturnType<typeof connectedClient>>,
    pending: PromiseLike<unknown>,
  ) {
    await db.close();
    const outcome = await pending.then(
      (value) => ({ resolved: value }),
      (reason: unknown) => ({ rejected: reason }),
    );
    expect.soft(unhandledRejections).toEqual([]);
    expect.soft(outcome).toEqual({ rejected: expect.objectContaining(runtimeClosedError) });
    expect(poolEndSpy()).toHaveBeenCalledTimes(1);
  }

  it('an ORM read rejects with the runtime closed error and the pool ends once', async () => {
    const db = await connectedClient();

    await closeWhilePending(db, db.orm.public.User.all());
  });

  it('a transaction rejects with the runtime closed error and the pool ends once', async () => {
    const db = await connectedClient();

    await closeWhilePending(
      db,
      db.transaction(async (tx) => (await tx.orm.public.User.all()).length),
    );
  });

  it('an execute rejects with the runtime closed error and the pool ends once', async () => {
    const db = await connectedClient();

    await closeWhilePending(
      db,
      db.runtime().execute(
        db.sql.public.users
          .update({ name: 'probe' })
          .where((f, fns) => fns.eq(f.id, 1))
          .build(),
      ),
    );
  });
});
