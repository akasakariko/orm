import type { ColumnDefaultLiteralInputValue } from '@internal/contract/types';
import type { CodecRef } from '@internal/sql-relational-core/ast';
import { col, lit } from '@internal/sql-relational-core/contract-free';
import { createPostgresBuiltinCodecLookup } from '@internal/target-postgres/codecs';
import { PostgresCreateTable } from '@internal/target-postgres/ddl';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresControlAdapter } from '../../src/core/control-adapter';
import {
  createDriver,
  createTestDatabase,
  type PostgresControlDriver,
  resetDatabase,
  testTimeout,
} from './fixtures/runner-fixtures';

interface DefaultCase {
  readonly column: string;
  readonly type: string;
  readonly codecRef: CodecRef;
  readonly literal: ColumnDefaultLiteralInputValue;
}

const cases: readonly DefaultCase[] = [
  {
    column: 'bytes',
    type: 'bytea[]',
    codecRef: { codecId: 'pg/bytea@1', many: true },
    literal: ['aGVsbG8='],
  },
  {
    column: 'documents',
    type: 'jsonb[]',
    codecRef: { codecId: 'pg/jsonb@1', many: true },
    literal: [{ a: 1 }, 'x'],
  },
  {
    column: 'span',
    type: 'interval',
    codecRef: { codecId: 'pg/interval@1' },
    literal: 'P1DT2H',
  },
  {
    column: 'spans',
    type: 'interval[]',
    codecRef: { codecId: 'pg/interval@1', many: true },
    literal: ['P1DT2H', 'PT-0.5S'],
  },
];

const table = 'Defaults';

function createTable(): PostgresCreateTable {
  return new PostgresCreateTable({
    table,
    columns: [
      col('id', 'int4', { notNull: true, primaryKey: true }),
      ...cases.map((defaultCase) =>
        col(defaultCase.column, defaultCase.type, {
          default: lit(defaultCase.literal),
          codecRef: defaultCase.codecRef,
        }),
      ),
    ],
  });
}

interface StoredRow {
  readonly bytes: unknown;
  readonly documents: unknown;
  readonly span: unknown;
  readonly spans: unknown;
}

describe('literal defaults rendered through the column codec', { concurrent: false }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let driver: PostgresControlDriver | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, testTimeout);

  afterAll(async () => {
    if (database) await database.close();
  }, testTimeout);

  beforeEach(async () => {
    driver = await createDriver(database.connectionString);
    await resetDatabase(driver);
  }, testTimeout);

  afterEach(async () => {
    if (driver) {
      await driver.close();
      driver = undefined;
    }
  }, testTimeout);

  it('stores the codec values of bytea, jsonb and interval defaults', {
    timeout: testTimeout,
  }, async () => {
    const adapter = new PostgresControlAdapter(createPostgresBuiltinCodecLookup());
    const ddl = await adapter.lowerToExecuteRequest(createTable());
    await driver!.query(ddl.sql);

    await driver!.query(`INSERT INTO "${table}" ("id") VALUES (1)`);
    await driver!.query(`SET IntervalStyle = 'iso_8601'`);
    const { rows } = await driver!.query<StoredRow>(
      `SELECT (SELECT jsonb_agg(convert_from(element, 'UTF8')) FROM unnest("bytes") AS element) AS "bytes",
              to_jsonb("documents") AS "documents",
              to_jsonb("span") AS "span",
              to_jsonb("spans") AS "spans"
         FROM "${table}"`,
    );
    expect(rows).toEqual([
      {
        bytes: ['hello'],
        documents: [{ a: 1 }, 'x'],
        span: 'P1DT2H',
        spans: ['P1DT2H', 'PT-0.5S'],
      },
    ]);
  });
});
