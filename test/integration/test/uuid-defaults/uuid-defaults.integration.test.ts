import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { int4Column } from '@internal/adapter-postgres/column-types';
import postgresAdapter from '@internal/adapter-postgres/control';
import { createControlClient } from '@internal/cli/control-api';
import postgresDriver from '@internal/driver-postgres/control';
import sql from '@internal/family-sql/control';
import { createControlStack } from '@internal/framework-components/control';
import { defineContract, field, model } from '@internal/postgres/contract-builder';
import { sqlContractCanonicalizationHooks } from '@internal/sql-contract/canonicalization-hooks';
import { sqlEmission } from '@internal/sql-contract-emitter';
import { prismaContract } from '@internal/sql-contract-psl/provider';
import postgres from '@internal/target-postgres/control';
import postgresPackRef from '@internal/target-postgres/pack';
import { postgresCreateNamespace } from '@internal/target-postgres/types';
import { timeouts, withClient, withDevDatabase } from '@repo/test-utils';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emit } from '../../utils/emit';
import { createIntegrationTestDir } from '../utils/cli-test-helpers';

const schema = `// use prisma-8

model T {
  id              Int    @id
  literal         Uuid   @default("A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11")
  sqlLiteral      Uuid   @default(sql\`'B0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'::uuid\`)
  braced          Uuid   @default("{C0EEBC99-9C0B4EF8-BB6D6BB9-BD380A11}")
  literalList     Uuid[] @default(["D0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11"])
  sqlArrayLiteral Uuid[] @default(sql\`'{E0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11}'::uuid[]\`)
  sqlConstructor  Uuid[] @default(sql\`ARRAY['F0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'::uuid]\`)
}
`;

const uuidColumn = { codecId: 'pg/uuid@1', nativeType: 'uuid' } as const;

interface EmittedColumns {
  readonly storage: {
    readonly namespaces: {
      readonly public: {
        readonly entries: {
          readonly table: {
            readonly T: { readonly columns: Record<string, { default?: unknown }> };
          };
        };
      };
    };
  };
}

function createClient() {
  return createControlClient({
    family: sql,
    target: postgres,
    adapter: postgresAdapter,
    driver: postgresDriver,
    extensions: [],
  });
}

function defaultsOf(contractJson: Record<string, unknown>): Record<string, unknown> {
  const columns = (contractJson as unknown as EmittedColumns).storage.namespaces.public.entries
    .table.T.columns;
  return Object.fromEntries(
    Object.entries(columns).map(([name, column]) => [name, column.default]),
  );
}

async function initAndVerify(
  connectionString: string,
  contractJson: Record<string, unknown>,
  migrationsDir: string,
): Promise<{ readonly init: unknown; readonly verify?: unknown }> {
  const client = createClient();
  try {
    await client.connect(connectionString);
    const init = await client.dbInit({ contract: contractJson, mode: 'apply', migrationsDir });
    if (!init.ok) return { init: init.failure };
    const verified = await client.dbVerify({
      contract: postgres.contractSerializer.deserializeContract(contractJson),
      migrationsDir,
      strict: true,
      skipSchema: false,
      skipMarker: false,
    });
    if (!verified.ok) return { init: 'applied', verify: verified.failure };
    return {
      init: 'applied',
      verify: {
        markerDrift: verified.value.markerDrift,
        unclaimed: verified.value.unclaimed,
        issues: [...verified.value.schemaResults.values()].flatMap(
          (result) => result.schema.issues,
        ),
      },
    };
  } finally {
    await client.close();
  }
}

/** Runs db init and db verify --strict, then inserts a row that takes every default and reads it back. */
async function initVerifyAndRead(contractJson: Record<string, unknown>, migrationsDir: string) {
  return withDevDatabase(async ({ connectionString }) => {
    const checked = await initAndVerify(connectionString, contractJson, migrationsDir);
    if (checked.init !== 'applied') return checked;
    const stored = await withClient(connectionString, async (raw) => {
      await raw.query('INSERT INTO "T" (id) VALUES (1)');
      const rows = await raw.query<{ row: Record<string, unknown> }>(
        `SELECT to_jsonb(t) - 'id' AS row FROM "T" t`,
      );
      return rows.rows.map((row) => row.row);
    });
    return { ...checked, stored };
  });
}

const initializedAndVerified = {
  init: 'applied',
  verify: { markerDrift: null, unclaimed: [], issues: [] },
};

describe(
  'uuid defaults written in a spelling other than the one Postgres prints',
  () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createIntegrationTestDir();
    });

    afterEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    });

    it(
      'in PSL, emit as the lower-case text Postgres stores, are created by db init, and pass db verify --strict',
      async () => {
        const schemaPath = join(testDir, 'schema.prisma');
        writeFileSync(schemaPath, schema, 'utf-8');

        const emitted = await createClient().emit({
          contractConfig: {
            source: prismaContract(schemaPath, {
              target: postgresPackRef,
              createNamespace: postgresCreateNamespace,
            }).source,
            output: join(testDir, 'contract.json'),
          },
        });
        if (!emitted.ok) throw new Error(JSON.stringify(emitted.failure, null, 2));
        const contractJson = JSON.parse(emitted.value.contractJson) as Record<string, unknown>;

        expect(defaultsOf(contractJson)).toEqual({
          id: undefined,
          literal: { kind: 'literal', value: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
          sqlLiteral: {
            kind: 'function',
            expression: "'B0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'::uuid",
          },
          braced: { kind: 'literal', value: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
          literalList: { kind: 'literal', value: ['d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'] },
          sqlArrayLiteral: {
            kind: 'function',
            expression: "'{E0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11}'::uuid[]",
          },
          sqlConstructor: {
            kind: 'function',
            expression: "ARRAY['F0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'::uuid]",
          },
        });

        await expect(initVerifyAndRead(contractJson, join(testDir, 'migrations'))).resolves.toEqual(
          {
            ...initializedAndVerified,
            stored: [
              {
                literal: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
                sqlLiteral: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
                braced: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
                literalList: ['d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
                sqlArrayLiteral: ['e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
                sqlConstructor: ['f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
              },
            ],
          },
        );
      },
      timeouts.spinUpPpgDev,
    );

    it(
      'in the TypeScript builder, emit as the lower-case text Postgres stores, are created by db init, and pass db verify --strict',
      async () => {
        const contract = defineContract({
          models: {
            T: model('T', {
              fields: {
                id: field.column(int4Column).id(),
                literal: field.column(uuidColumn).default('A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'),
                braced: field.column(uuidColumn).default('{C0EEBC99-9C0B4EF8-BB6D6BB9-BD380A11}'),
                literalList: field
                  .column(uuidColumn)
                  .many()
                  .default(['D0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11']),
              },
            }).sql({ table: 'T' }),
          },
        });
        const emitted = await emit(
          contract,
          createControlStack({ family: sql, target: postgres, adapter: postgresAdapter }),
          sqlEmission,
          {
            serializeContract: (c) =>
              postgres.contractSerializer.serializeContract(
                c as Parameters<typeof postgres.contractSerializer.serializeContract>[0],
              ),
            ...sqlContractCanonicalizationHooks,
          },
        );
        const contractJson = JSON.parse(emitted.contractJson) as Record<string, unknown>;

        expect(defaultsOf(contractJson)).toEqual({
          id: undefined,
          literal: { kind: 'literal', value: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
          braced: { kind: 'literal', value: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
          literalList: { kind: 'literal', value: ['d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'] },
        });

        await expect(initVerifyAndRead(contractJson, join(testDir, 'migrations'))).resolves.toEqual(
          {
            ...initializedAndVerified,
            stored: [
              {
                literal: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
                braced: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
                literalList: ['d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
              },
            ],
          },
        );
      },
      timeouts.spinUpPpgDev,
    );
  },
  timeouts.spinUpPpgDev,
);
