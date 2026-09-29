import { instantiateExecutionStack } from '@internal/framework-components/execution';
import type {
  MarkerReadResult,
  SqlDriver,
  SqlExecuteRequest,
} from '@internal/sql-relational-core/ast';
import { RawQueryAst } from '@internal/sql-relational-core/ast';
import type { AffectedCount } from '@internal/sql-relational-core/expression';
import type { SqlQueryPlan } from '@internal/sql-relational-core/plan';
import { planFromAst } from '@internal/sql-relational-core/plan';
import { describe, expect, it, vi } from 'vitest';
import { createSqlExecutionStack } from '../src/sql-context';
import { withTransaction } from '../src/sql-runtime';
import {
  createStubAdapter,
  createTestAdapterDescriptor,
  createTestContext,
  createTestContract,
  createTestRuntime,
  createTestStackInstance,
  createTestTargetDescriptor,
  type StubAdapter,
} from './utils';

/**
 * A runtime whose `close()` has started refuses every operation that would reach the driver.
 * An operation that holds no connection rejects only after the close has settled, so the
 * rejection cannot precede the caller's handler. An operation on a held connection rejects at
 * once, because the driver's close waits for that connection to be released.
 */

const contract = createTestContract({ storageHash: 'runtime-closed' });

const closedError = {
  code: 'DRIVER.NOT_CONNECTED',
  message: 'Runtime is closed',
};

function createStubDriver() {
  const calls: string[] = [];
  let heldConnections = 0;
  const releaseWaiters: Array<() => void> = [];

  const releaseHeld = async (): Promise<void> => {
    heldConnections -= 1;
    for (const wake of releaseWaiters.splice(0)) wake();
  };

  const transaction = {
    query: vi.fn().mockImplementation(async function* (_request: SqlExecuteRequest) {
      calls.push('transaction.query');
      yield { id: 1 };
    }),
    execute: vi.fn().mockImplementation(async (_request: SqlExecuteRequest) => {
      calls.push('transaction.execute');
      return { affectedRows: 1 };
    }),
    commit: vi.fn().mockImplementation(async () => {
      calls.push('commit');
    }),
    rollback: vi.fn().mockImplementation(async () => {
      calls.push('rollback');
    }),
  };

  const connection = {
    query: vi.fn().mockImplementation(async function* (_request: SqlExecuteRequest) {
      calls.push('connection.query');
      yield { id: 1 };
    }),
    execute: vi.fn().mockImplementation(async (_request: SqlExecuteRequest) => {
      calls.push('connection.execute');
      return { affectedRows: 1 };
    }),
    release: vi.fn().mockImplementation(async () => {
      calls.push('release');
      await releaseHeld();
    }),
    destroy: vi.fn().mockImplementation(async () => {
      calls.push('destroy');
      await releaseHeld();
    }),
    beginTransaction: vi.fn().mockResolvedValue(transaction),
  };

  const driver: SqlDriver = {
    query: vi.fn().mockImplementation(async function* (_request: SqlExecuteRequest) {
      calls.push('driver.query');
      yield { id: 1 };
    }),
    execute: vi.fn().mockImplementation(async (_request: SqlExecuteRequest) => {
      calls.push('driver.execute');
      return { affectedRows: 1 };
    }),
    connect: vi.fn().mockResolvedValue(undefined),
    acquireConnection: vi.fn().mockImplementation(async () => {
      heldConnections += 1;
      calls.push('acquire');
      return connection;
    }),
    close: vi.fn().mockImplementation(async () => {
      calls.push('close');
      while (heldConnections > 0) {
        await new Promise<void>((wake) => releaseWaiters.push(wake));
      }
      await new Promise((settle) => setTimeout(settle, 0));
      calls.push('closed');
    }),
  };

  return { driver, calls, connection, transaction };
}

function setup() {
  const stub = createStubDriver();
  const runtime = createTestRuntime({
    stackInstance: createTestStackInstance(),
    context: createTestContext(contract, createStubAdapter()),
    driver: stub.driver,
    verifyMarker: false,
  });
  return { runtime, ...stub };
}

function setupWithMarkerReader(readMarker: () => Promise<MarkerReadResult>) {
  const stub = createStubDriver();
  const base = createStubAdapter();
  const adapter: StubAdapter = { ...base, profile: { ...base.profile, readMarker } };
  const stack = createSqlExecutionStack({
    target: createTestTargetDescriptor(),
    adapter: createTestAdapterDescriptor(adapter),
    extensions: [],
  });
  const runtime = createTestRuntime({
    stackInstance: instantiateExecutionStack(stack),
    context: createTestContext(contract, adapter),
    driver: stub.driver,
  });
  return { runtime, ...stub };
}

function rowsPlan(): SqlQueryPlan<{ id: unknown }> {
  return planFromAst(
    RawQueryAst.rows(['select id from "user"'], { id: { codecId: 'pg/int4@1', nullable: false } }),
    contract,
  );
}

function affectedCountPlan(): SqlQueryPlan<AffectedCount> {
  return planFromAst(RawQueryAst.affectedCount(['update "user" set seen = now()']), contract);
}

describe('the closed error', () => {
  it('names the runtime, the two ways it closes, and the two likely mistakes', async () => {
    const { runtime } = setup();
    await runtime.close();

    await expect(runtime.execute(affectedCountPlan())).rejects.toMatchObject({
      code: 'DRIVER.NOT_CONNECTED',
      message: 'Runtime is closed',
      why: 'close() was called on this runtime, or the await using scope that held it has ended.',
      fix: 'Await every query, transaction and prepared statement before the runtime closes. A query returned without await from an await using scope, or started after close(), runs after the connection has closed.',
    });
  });
});

describe('close()', () => {
  it('closes the driver once however often it is called', async () => {
    const { runtime, driver } = setup();

    await Promise.all([runtime.close(), runtime.close()]);
    await runtime.close();

    expect(driver.close).toHaveBeenCalledTimes(1);
  });
});

describe('an operation started before close() that holds no connection', () => {
  it('rejects with the closed error after the close has settled and makes no driver call', async () => {
    const { runtime, driver } = setup();
    const settled: string[] = [];

    const pending = runtime.execute(affectedCountPlan()).finally(() => settled.push('execute'));
    const closing = runtime.close().finally(() => settled.push('close'));

    await expect(pending).rejects.toMatchObject(closedError);
    await closing;
    expect(settled).toEqual(['close', 'execute']);
    expect(driver.execute).not.toHaveBeenCalled();
  });
});

describe('an operation started after close()', () => {
  it('execute() rejects with the closed error and makes no driver call', async () => {
    const { runtime, driver } = setup();
    await runtime.close();

    await expect(runtime.execute(affectedCountPlan())).rejects.toMatchObject(closedError);
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it('query() rejects with the closed error when its rows are read and makes no driver call', async () => {
    const { runtime, driver } = setup();
    await runtime.close();

    await expect(runtime.query(rowsPlan()).toArray()).rejects.toMatchObject(closedError);
    expect(driver.query).not.toHaveBeenCalled();
  });

  it('connection() rejects with the closed error and acquires nothing', async () => {
    const { runtime, driver } = setup();
    await runtime.close();

    await expect(runtime.connection()).rejects.toMatchObject(closedError);
    expect(driver.acquireConnection).not.toHaveBeenCalled();
  });

  it('a prepared query and a prepared execute reject with the closed error', async () => {
    const { runtime, driver } = setup();
    const preparedQuery = await runtime.prepare({}, () => rowsPlan());
    const preparedExecute = await runtime.prepare({}, () => affectedCountPlan());
    await runtime.close();

    await expect(preparedQuery.query(runtime, {}).toArray()).rejects.toMatchObject(closedError);
    await expect(preparedExecute.execute(runtime, {})).rejects.toMatchObject(closedError);
    expect(driver.query).not.toHaveBeenCalled();
    expect(driver.execute).not.toHaveBeenCalled();
  });
});

describe('an operation on a connection held when close() starts', () => {
  it('rejects at once, and the close completes once the connection is released', async () => {
    const { runtime, connection } = setup();
    const held = await runtime.connection();
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });

    await expect(held.query(rowsPlan()).toArray()).rejects.toMatchObject(closedError);
    await expect(held.execute(affectedCountPlan())).rejects.toMatchObject(closedError);
    expect(closed).toBe(false);
    expect(connection.query).not.toHaveBeenCalled();
    expect(connection.execute).not.toHaveBeenCalled();

    await held.release();
    await closing;
    expect(closed).toBe(true);
  });
});

describe('withTransaction when close() starts while the transaction holds its connection', () => {
  it('rolls back, releases the connection, and rejects with the closed error after the close has settled', async () => {
    const { runtime, calls, transaction } = setup();
    const settled: string[] = [];
    let closing: Promise<void> | undefined;

    const pending = withTransaction(runtime, async (tx) => {
      closing = runtime.close().finally(() => settled.push('close'));
      await tx.execute(affectedCountPlan());
    }).finally(() => settled.push('transaction'));

    await expect(pending).rejects.toMatchObject(closedError);
    await closing;
    expect(settled).toEqual(['close', 'transaction']);
    expect(transaction.execute).not.toHaveBeenCalled();
    expect(calls).toEqual(['acquire', 'close', 'rollback', 'release', 'closed']);
  });
});

describe('a marker read that fails', () => {
  it('is retried by the next query instead of failing every later query', async () => {
    const readMarker = vi
      .fn<() => Promise<MarkerReadResult>>()
      .mockRejectedValueOnce(new Error('simulated transient failure'))
      .mockResolvedValue({ kind: 'absent' });
    const { runtime, driver } = setupWithMarkerReader(readMarker);

    await expect(runtime.execute(affectedCountPlan())).rejects.toThrow(
      'simulated transient failure',
    );
    await expect(runtime.execute(affectedCountPlan())).resolves.toEqual({ affectedRows: 1 });

    expect(readMarker).toHaveBeenCalledTimes(2);
    expect(driver.execute).toHaveBeenCalledTimes(1);
  });
});
