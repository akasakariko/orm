import type { Contract } from '@internal/contract/types';
import type { SqlStorage } from '@internal/sql-contract/types';
import type { Runtime } from '@internal/sql-runtime';
import { expectTypeOf, test } from 'vitest';
import type {
  PostgresOptionsWithContract,
  PostgresOptionsWithContractJson,
} from '../src/runtime/postgres';
import type postgresServerless from '../src/runtime/postgres-serverless';
import type { PostgresServerlessClient } from '../src/runtime/postgres-serverless';
import type { Contract as FixtureContract } from './fixtures/generated/contract';

type TestContract = Contract<SqlStorage>;
type Db = PostgresServerlessClient<TestContract>;
type Connection = Awaited<ReturnType<Db['connect']>>;

test('the module-scope client has the static members and connect', () => {
  expectTypeOf<keyof Db>().toEqualTypeOf<
    'sql' | 'raw' | 'enums' | 'nativeEnums' | 'context' | 'contract' | 'stack' | 'connect'
  >();
});

test('the connection has the static members, the runtime-bound members, close and dispose', () => {
  expectTypeOf<keyof Connection>().toEqualTypeOf<
    | 'sql'
    | 'raw'
    | 'enums'
    | 'nativeEnums'
    | 'context'
    | 'contract'
    | 'stack'
    | 'orm'
    | 'runtime'
    | 'transaction'
    | 'prepare'
    | 'close'
    | typeof Symbol.asyncDispose
  >();
});

test('the connection is not a Runtime', () => {
  expectTypeOf<Connection>().not.toMatchTypeOf<Runtime>();
  expectTypeOf<Extract<keyof Connection, 'query' | 'execute'>>().toBeNever();
});

test('the connection types orm and the transaction context from the contract', async () => {
  const db = {} as Awaited<ReturnType<PostgresServerlessClient<FixtureContract>['connect']>>;

  expectTypeOf(db.orm.public).not.toBeAny();
  expectTypeOf(db.orm.public.User).toHaveProperty('all');

  await db.transaction(async (tx) => {
    expectTypeOf(tx).not.toBeAny();
    expectTypeOf(tx.orm.public).not.toBeAny();
    expectTypeOf(tx.orm.public.User).toHaveProperty('all');
  });
});

test('connect() rejects bindings other than { url }', () => {
  const db = {} as Db;
  expectTypeOf(db.connect).parameter(0).toEqualTypeOf<{ readonly url: string }>();
  // @ts-expect-error binding is restricted to { url }; pg/binding shapes are not accepted
  void db.connect({ pg: {} as unknown });
  // @ts-expect-error binding is restricted to { url }; binding shape is not accepted
  void db.connect({ binding: { kind: 'url', url: 'x' } });
});

test('factory accepts the same option keys as the Node postgres() factory', async () => {
  const { default: postgres } = await import('../src/runtime/postgres');
  type NodeOptionKeys = keyof Pick<
    PostgresOptionsWithContract<TestContract>,
    'contract' | 'extensions' | 'middleware' | 'verifyMarker' | 'cursor'
  >;
  type ServerlessOptionKeys = Parameters<typeof postgresServerless<TestContract>>[0] extends infer O
    ? Extract<keyof O, 'contract' | 'extensions' | 'middleware' | 'verifyMarker' | 'cursor'>
    : never;
  expectTypeOf<ServerlessOptionKeys>().toEqualTypeOf<NodeOptionKeys>();

  type NodeJsonKeys = keyof Pick<
    PostgresOptionsWithContractJson<TestContract>,
    'contractJson' | 'extensions' | 'middleware' | 'verifyMarker' | 'cursor'
  >;
  type ServerlessJsonKeys = Parameters<typeof postgresServerless<TestContract>>[0] extends infer O
    ? Extract<keyof O, 'contractJson' | 'extensions' | 'middleware' | 'verifyMarker' | 'cursor'>
    : never;
  expectTypeOf<ServerlessJsonKeys>().toEqualTypeOf<NodeJsonKeys>();

  expectTypeOf<Parameters<typeof postgresServerless<TestContract>>[0]['cursor']>().toEqualTypeOf<
    PostgresOptionsWithContract<TestContract>['cursor']
  >();

  // postgres() also accepts these but the unrelated `postgres()` ensures the symbol is referenced
  void postgres;
});
