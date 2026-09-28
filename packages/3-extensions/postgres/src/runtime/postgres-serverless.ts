import postgresAdapter from '@internal/adapter-postgres/runtime';
import type { Contract } from '@internal/contract/types';
import postgresDriver, {
  type PostgresDriverCreateOptions,
  suppressIdleConnectionErrors,
} from '@internal/driver-postgres/runtime';
import { instantiateExecutionStack } from '@internal/framework-components/execution';
import type { SqlStorage } from '@internal/sql-contract/types';
import type {
  Runtime,
  SqlMiddleware,
  SqlRuntimeExtensionDescriptor,
  VerifyMarkerOption,
} from '@internal/sql-runtime';
import { createExecutionContext, createSqlExecutionStack } from '@internal/sql-runtime';
import postgresTarget, { PostgresContractSerializer } from '@internal/target-postgres/runtime';
import { blindCast } from '@internal/utils/casts';
import { ifDefined } from '@internal/utils/defined';
import { InternalError } from '@internal/utils/internal-error';
import { Client } from 'pg';
import { postgresError } from '../errors';
import { buildPostgresStaticContext } from '../static/postgres-static';
import type { PostgresTargetId } from './postgres';
import { PostgresRuntimeImpl } from './postgres-runtime';
import {
  buildPostgresRuntimeBoundMembers,
  type PostgresClientLifecycle,
  type PostgresRuntimeBoundMembers,
  type PostgresStaticMembers,
} from './postgres-runtime-bound-members';

export type PostgresServerlessCursorOptions = NonNullable<PostgresDriverCreateOptions['cursor']>;

export interface PostgresServerlessConnection<TContract extends Contract<SqlStorage>>
  extends PostgresStaticMembers<TContract>,
    PostgresRuntimeBoundMembers<TContract>,
    PostgresClientLifecycle {}

export interface PostgresServerlessClient<TContract extends Contract<SqlStorage>>
  extends PostgresStaticMembers<TContract> {
  connect(binding: { readonly url: string }): Promise<PostgresServerlessConnection<TContract>>;
}

export interface PostgresServerlessOptionsBase {
  readonly extensions?: readonly SqlRuntimeExtensionDescriptor<PostgresTargetId>[];
  readonly middleware?: readonly SqlMiddleware[];
  readonly verifyMarker?: VerifyMarkerOption;
  readonly cursor?: PostgresServerlessCursorOptions;
}

export type PostgresServerlessOptionsWithContract<TContract extends Contract<SqlStorage>> =
  PostgresServerlessOptionsBase & {
    readonly contract: TContract;
    readonly contractJson?: never;
  };

export type PostgresServerlessOptionsWithContractJson<TContract extends Contract<SqlStorage>> =
  PostgresServerlessOptionsBase & {
    readonly contractJson: unknown;
    readonly contract?: never;
    readonly _contract?: TContract;
  };

export type PostgresServerlessOptions<TContract extends Contract<SqlStorage>> =
  | PostgresServerlessOptionsWithContract<TContract>
  | PostgresServerlessOptionsWithContractJson<TContract>;

function hasContractJson<TContract extends Contract<SqlStorage>>(
  options: PostgresServerlessOptions<TContract>,
): options is PostgresServerlessOptionsWithContractJson<TContract> {
  return 'contractJson' in options;
}

const contractSerializer = new PostgresContractSerializer();

function resolveContract<TContract extends Contract<SqlStorage>>(
  options: PostgresServerlessOptions<TContract>,
): TContract {
  const contractJson = hasContractJson(options)
    ? options.contractJson
    : contractSerializer.serializeContract(options.contract);
  return blindCast<
    TContract,
    'caller supplies the generic contract type that matches the serialized Postgres contract'
  >(contractSerializer.deserializeContract(contractJson));
}

function validateConnectionString(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    throw postgresError('RUNTIME.BINDING_INVALID', 'Postgres URL must be a non-empty string', {
      meta: { extension: 'postgres', reason: 'empty url' },
    });
  }
  return trimmed;
}

function closedConnectionError() {
  return postgresError('DRIVER.NOT_CONNECTED', 'Postgres connection is closed', {
    why: 'close() was called on this connection, or the await using scope that held it has ended.',
    fix: 'Call connect({ url }) again to open a new connection.',
    meta: { extension: 'postgres' },
  });
}

/**
 * Postgres client for serverless and edge runtimes (Cloudflare Workers + Hyperdrive, AWS Lambda, Vercel, Deno Deploy).
 *
 * The returned client holds no connection and exposes the static query surfaces. Each `connect({ url })` opens one fresh `pg.Client` and returns a per-request client with the members of a `postgres()` client except `connect`. Close it with `await using` or `close()`.
 *
 * @example
 * ```ts
 * const postgres = postgresServerless<Contract>({ contractJson });
 *
 * export default {
 *   async fetch(_req: Request, env: Env): Promise<Response> {
 *     await using db = await postgres.connect({ url: env.HYPERDRIVE.connectionString });
 *     const users = await db.orm.public.User.all();
 *     return Response.json(users);
 *   },
 * };
 * ```
 */
export default function postgresServerless<TContract extends Contract<SqlStorage>>(
  options: PostgresServerlessOptionsWithContract<TContract>,
): PostgresServerlessClient<TContract>;
export default function postgresServerless<TContract extends Contract<SqlStorage>>(
  options: PostgresServerlessOptionsWithContractJson<TContract>,
): PostgresServerlessClient<TContract>;
export default function postgresServerless<TContract extends Contract<SqlStorage>>(
  options: PostgresServerlessOptions<TContract>,
): PostgresServerlessClient<TContract> {
  const contract = resolveContract(options);
  const stack = createSqlExecutionStack({
    target: postgresTarget,
    adapter: postgresAdapter,
    driver: postgresDriver,
    extensions: options.extensions ?? [],
  });

  const context = createExecutionContext<TContract, PostgresTargetId>({
    contract,
    stack,
    driver: postgresDriver,
  });
  const rawCodecInferer = stack.adapter.rawCodecInferer;
  const { sql, raw, enums, nativeEnums } = buildPostgresStaticContext<TContract>(
    context,
    rawCodecInferer,
  );

  const openConnection = (runtime: Runtime): PostgresServerlessConnection<TContract> => {
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= runtime.close();
      return closing;
    };
    const runtimeBoundMembers = buildPostgresRuntimeBoundMembers<TContract>({
      context,
      rawCodecInferer,
      enums,
      nativeEnums,
      getRuntime: () => {
        if (closing !== undefined) {
          throw closedConnectionError();
        }
        return runtime;
      },
    });

    return {
      sql,
      raw,
      enums,
      nativeEnums,
      context,
      contract,
      stack,
      ...runtimeBoundMembers,
      close,
      [Symbol.asyncDispose]: close,
    };
  };

  return {
    sql,
    raw,
    enums,
    nativeEnums,
    context,
    stack,
    contract,

    async connect(binding) {
      const url = validateConnectionString(binding.url);

      const driverDescriptor = stack.driver;
      if (!driverDescriptor) {
        throw new InternalError('Driver descriptor missing from execution stack');
      }

      const stackInstance = instantiateExecutionStack(stack);
      const driver = driverDescriptor.create({
        ...ifDefined('cursor', options.cursor),
      });

      const client = suppressIdleConnectionErrors(new Client({ connectionString: url }));
      await driver.connect({ kind: 'pgClient', client });

      let runtime: Runtime;
      try {
        runtime = new PostgresRuntimeImpl({
          context,
          adapter: stackInstance.adapter,
          driver,
          ...ifDefined('verifyMarker', options.verifyMarker),
          ...ifDefined('middleware', options.middleware),
        });
      } catch (err) {
        // The driver is bound to the pg.Client at this point; without a runtime
        // to wrap it, the caller has no handle to dispose. Close the driver so
        // the underlying pg.Client is released even if its TCP socket has not
        // yet opened (lazy connect): keeps cleanup symmetric with successful
        // construction and prevents real socket leaks if pg ever changes its
        // connect semantics.
        await driver.close().catch(() => undefined);
        throw err;
      }

      return openConnection(runtime);
    },
  };
}
