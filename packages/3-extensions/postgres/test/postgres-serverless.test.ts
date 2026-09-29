import type { SqlStorage } from '@internal/sql-contract/types';
import { validateSqlContractFully } from '@internal/sql-contract/validators';
import type { SqlMiddleware } from '@internal/sql-runtime';
import { createContract } from '@repo/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contract } from './fixtures/generated/contract';
import fixtureContractJson from './fixtures/generated/contract.json' with { type: 'json' };

type QueryMock = ReturnType<typeof vi.fn>;
interface RecordedClient {
  readonly connectionString: string | undefined;
  readonly query: QueryMock;
}

const recorded = vi.hoisted(() => ({
  clients: [] as RecordedClient[],
  poolCount: 0,
}));

// Only mock the third-party pg boundary. Real drivers, adapters, and runtimes
// run over this fake client.
vi.mock('pg', () => {
  class Pool {
    on = vi.fn().mockReturnThis();
    connect = vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    });
    end = vi.fn().mockResolvedValue(undefined);
    constructor() {
      recorded.poolCount += 1;
    }
  }

  class Client {
    on = vi.fn().mockReturnThis();
    connect = vi.fn().mockResolvedValue(undefined);
    query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    end = vi.fn().mockResolvedValue(undefined);
    readonly connectionString: string | undefined;
    constructor(config?: { connectionString?: string }) {
      this.connectionString = config?.connectionString;
      recorded.clients.push(this);
    }
  }

  return { Pool, Client };
});

import postgres from '../src/runtime/postgres';
import postgresServerless from '../src/runtime/postgres-serverless';

const contract = createContract<SqlStorage>();
const fixtureContract = validateSqlContractFully<Contract>(fixtureContractJson);
const url = 'postgres://localhost:5432/db';

function fixtureClient() {
  return postgresServerless<Contract>({
    contractJson: fixtureContract,
    verifyMarker: false,
  });
}

function lastClient(): RecordedClient {
  const client = recorded.clients.at(-1);
  if (!client) throw new Error('no pg.Client was constructed');
  return client;
}

function statementsOf(client: RecordedClient): string[] {
  return client.query.mock.calls.map(([request]) =>
    typeof request === 'string' ? request : JSON.stringify(request),
  );
}

const closedConnectionError = {
  code: 'DRIVER.NOT_CONNECTED',
  message: 'Postgres connection is closed',
  why: 'close() was called on this connection, or the await using scope that held it has ended.',
  fix: 'Call connect({ url }) again to open a new connection.',
  meta: { extension: 'postgres' },
};

beforeEach(() => {
  vi.clearAllMocks();
  recorded.clients.length = 0;
  recorded.poolCount = 0;
});

describe('postgresServerless module-scope client', () => {
  it('has exactly the static members and connect', () => {
    const db = postgresServerless({ contract });

    expect(Object.keys(db).sort()).toEqual(
      ['connect', 'context', 'contract', 'enums', 'nativeEnums', 'raw', 'sql', 'stack'].sort(),
    );
  });

  it('does not construct a pg.Client or pg.Pool at construction time', () => {
    postgresServerless({ contract });

    expect(recorded.clients).toHaveLength(0);
    expect(recorded.poolCount).toBe(0);
  });

  it('validates contractJson input', () => {
    expect(() => postgresServerless({ contractJson: { target: 'postgres' } })).toThrow();
    expect(postgresServerless<Contract>({ contractJson: fixtureContract }).contract.target).toBe(
      'postgres',
    );
  });

  it('validates direct contract input', () => {
    expect(postgresServerless({ contract }).contract.target).toBe('postgres');
  });
});

describe('postgresServerless connect()', () => {
  it('returns an object with the own keys of a postgres() client except connect', async () => {
    const nodeClient = postgres({ contract, url });
    const db = await postgresServerless({ contract }).connect({ url });

    const expected = Object.keys(nodeClient)
      .filter((key) => key !== 'connect')
      .sort();
    expect(Object.keys(db).sort()).toEqual(expected);
    expect(typeof db[Symbol.asyncDispose]).toBe('function');

    await db.close();
    await nodeClient.close();
  });

  it('shares the static members of the module-scope client', async () => {
    const serverless = postgresServerless({ contract });
    const db = await serverless.connect({ url });

    expect(db.sql).toBe(serverless.sql);
    expect(db.raw).toBe(serverless.raw);
    expect(db.enums).toBe(serverless.enums);
    expect(db.nativeEnums).toBe(serverless.nativeEnums);
    expect(db.context).toBe(serverless.context);
    expect(db.contract).toBe(serverless.contract);
    expect(db.stack).toBe(serverless.stack);

    await db.close();
  });

  it('opens one pg.Client with the given URL per call', async () => {
    const serverless = postgresServerless({ contract });

    const first = await serverless.connect({ url });
    const second = await serverless.connect({ url: 'postgres://localhost:5432/other' });

    expect(recorded.clients.map((client) => client.connectionString)).toEqual([
      url,
      'postgres://localhost:5432/other',
    ]);
    expect(first).not.toBe(second);
    expect(first.runtime()).not.toBe(second.runtime());

    await first.close();
    await second.close();
  });

  it('never constructs a pg.Pool over a full connect and dispose lifecycle', async () => {
    const serverless = postgresServerless({ contract });

    {
      await using _db = await serverless.connect({ url });
    }

    expect(recorded.clients).toHaveLength(1);
    expect(recorded.poolCount).toBe(0);
  });

  it('rejects an empty URL without opening a pg.Client', async () => {
    const serverless = postgresServerless({ contract });

    await expect(serverless.connect({ url: '   ' })).rejects.toMatchObject({
      code: 'RUNTIME.BINDING_INVALID',
    });
    expect(recorded.clients).toHaveLength(0);
  });
});

describe('queries on a connection use its own pg.Client', () => {
  async function openTwo() {
    const serverless = fixtureClient();
    const idle = await serverless.connect({ url });
    const idleClient = lastClient();
    const used = await serverless.connect({ url });
    const usedClient = lastClient();
    return { used, usedClient, idle, idleClient };
  }

  it('db.orm', async () => {
    const { used, usedClient, idle, idleClient } = await openTwo();

    await used.orm.public.User.first();

    expect(usedClient.query).toHaveBeenCalled();
    expect(idleClient.query).not.toHaveBeenCalled();

    await used.close();
    await idle.close();
  });

  it('db.transaction', async () => {
    const { used, usedClient, idle, idleClient } = await openTwo();

    await used.transaction(async (tx) => {
      await tx.orm.public.User.first();
    });

    const statements = statementsOf(usedClient);
    expect(statements[0]).toMatch(/^BEGIN/);
    expect(statements.at(-1)).toMatch(/^COMMIT/);
    expect(idleClient.query).not.toHaveBeenCalled();

    await used.close();
    await idle.close();
  });

  it('db.prepare', async () => {
    const { used, idle } = await openTwo();
    const usedPrepare = vi.spyOn(used.runtime(), 'prepare');
    const idlePrepare = vi.spyOn(idle.runtime(), 'prepare');

    await used.prepare({ id: 'pg/int4@1' }, (params) =>
      used.sql.public.users
        .select('id')
        .where((f, fns) => fns.eq(f.id, params.id))
        .build(),
    );

    expect(usedPrepare).toHaveBeenCalledTimes(1);
    expect(idlePrepare).not.toHaveBeenCalled();

    await used.close();
    await idle.close();
  });
});

describe('a closed connection', () => {
  async function closedConnection() {
    const db = await fixtureClient().connect({ url });
    await db.close();
    return db;
  }

  it('db.runtime() fails with DRIVER.NOT_CONNECTED', async () => {
    const db = await closedConnection();

    expect(() => db.runtime()).toThrow(expect.objectContaining(closedConnectionError));
  });

  it('an ORM read fails with DRIVER.NOT_CONNECTED', async () => {
    const db = await closedConnection();

    await expect(db.orm.public.User.first()).rejects.toMatchObject(closedConnectionError);
  });

  it('db.transaction() fails with DRIVER.NOT_CONNECTED', async () => {
    const db = await closedConnection();

    expect(() => db.transaction(async () => undefined)).toThrow(
      expect.objectContaining(closedConnectionError),
    );
  });

  it('db.prepare() fails with DRIVER.NOT_CONNECTED', async () => {
    const db = await closedConnection();

    expect(() => db.prepare({}, () => db.sql.public.users.select('id').build())).toThrow(
      expect.objectContaining(closedConnectionError),
    );
  });
});

describe('closing a connection closes its runtime exactly once', () => {
  it('await using', async () => {
    const serverless = postgresServerless({ contract });
    let runtimeClose: ReturnType<typeof vi.spyOn> | undefined;

    {
      await using db = await serverless.connect({ url });
      runtimeClose = vi.spyOn(db.runtime(), 'close');
    }

    expect(runtimeClose).toHaveBeenCalledTimes(1);
  });

  it('a direct [Symbol.asyncDispose]() call', async () => {
    const db = await postgresServerless({ contract }).connect({ url });
    const runtimeClose = vi.spyOn(db.runtime(), 'close');

    await db[Symbol.asyncDispose]();

    expect(runtimeClose).toHaveBeenCalledTimes(1);
  });

  it('two close() calls', async () => {
    const db = await postgresServerless({ contract }).connect({ url });
    const runtimeClose = vi.spyOn(db.runtime(), 'close');

    await db.close();
    await db.close();

    expect(runtimeClose).toHaveBeenCalledTimes(1);
  });
});

describe('postgresServerless options', () => {
  it('forwards middleware to the connection runtime', async () => {
    const queried: string[] = [];
    const spyMiddleware: SqlMiddleware = {
      name: 'test-spy',
      familyId: 'sql',
      async afterQuery(plan) {
        queried.push(plan.sql);
      },
    };
    const serverless = postgresServerless<Contract>({
      contractJson: fixtureContract,
      verifyMarker: false,
      middleware: [spyMiddleware],
    });

    const db = await serverless.connect({ url });
    await db.orm.public.User.first();

    expect(queried).toHaveLength(1);
    expect(queried[0]).toMatch(/^SELECT/);
    await db.close();
  });

  it('verifyMarker: false skips the marker read before the first query', async () => {
    const db = await fixtureClient().connect({ url });
    const client = lastClient();

    await db.orm.public.User.first();

    const statements = statementsOf(client);
    expect(statements.some((sql) => sql.includes('prisma_contract'))).toBe(false);
    await db.close();
  });
});
