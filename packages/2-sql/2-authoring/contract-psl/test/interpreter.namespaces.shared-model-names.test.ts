import type { ContractModel } from '@internal/contract/types';
import type { ForeignKey, SqlModelStorage, SqlStorage } from '@internal/sql-contract/types';
import { describe, expect, it } from 'vitest';
import { createTestSqlNamespace } from '../../../1-core/contract/test/test-support';
import { interpretPslDocumentToSqlContract } from '../src/interpreter';
import { fixtureDataTypeSupport } from './fixture-data-types';
import {
  createBuiltinLikeControlMutationDefaults,
  postgresScalarTypeDescriptors,
  postgresTarget,
  symbolTableInputFromParseArgs,
} from './fixtures';

const baseInput = {
  dataTypeLookup: fixtureDataTypeSupport.lookup,
  target: postgresTarget,
  scalarColumnDescriptors: postgresScalarTypeDescriptors,
  controlMutationDefaults: createBuiltinLikeControlMutationDefaults(),
  composedExtensionContracts: new Map(),
  createNamespace: createTestSqlNamespace,
  capabilities: { sql: { scalarList: true } },
} as const;

describe('two namespaces declaring the same bare model name', () => {
  const schema = `namespace public {
  model User {
    id Int @id
    profiles Profile[]
    @@map("public_users")
  }
  model Profile {
    id Int @id
    userId Int
    user User @relation(fields: [userId], references: [id])
    @@map("profile")
  }
}

namespace auth {
  model User {
    id Int @id
    sessions Session[]
    @@map("auth_users")
  }
  model Session {
    id Int @id
    userId Int
    user User @relation(fields: [userId], references: [id])
    @@map("session")
  }
}
`;

  function interpret() {
    const result = interpretPslDocumentToSqlContract({
      ...baseInput,
      ...symbolTableInputFromParseArgs({ schema, sourceId: 'schema.prisma' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.failure.summary);
    return result.value;
  }

  function foreignKeysOf(storage: SqlStorage, namespaceId: string, table: string) {
    const entry = storage.namespaces[namespaceId]?.entries.table?.[table];
    expect(entry).toBeDefined();
    return (entry?.foreignKeys ?? []) as readonly ForeignKey[];
  }

  function modelsOf(
    contract: ReturnType<typeof interpret>,
    namespaceId: string,
  ): Record<string, ContractModel<SqlModelStorage>> | undefined {
    return contract.domain.namespaces[namespaceId]?.models as
      | Record<string, ContractModel<SqlModelStorage>>
      | undefined;
  }

  it('lowers each unqualified relation to the User declared in its own namespace', () => {
    const storage = interpret().storage as SqlStorage;

    expect(foreignKeysOf(storage, 'public', 'profile')).toMatchObject([
      { target: { namespaceId: 'public', tableName: 'public_users' } },
    ]);
    expect(foreignKeysOf(storage, 'auth', 'session')).toMatchObject([
      { target: { namespaceId: 'auth', tableName: 'auth_users' } },
    ]);
  });

  it('points each domain relation at the User in its own namespace', () => {
    const contract = interpret();

    expect(modelsOf(contract, 'public')?.['Profile']?.relations?.['user']?.to).toEqual({
      namespace: 'public',
      model: 'User',
    });
    expect(modelsOf(contract, 'auth')?.['Session']?.relations?.['user']?.to).toEqual({
      namespace: 'auth',
      model: 'User',
    });
  });

  it('pairs backrelations within each namespace when both model names are shared', () => {
    const shared = `namespace public {
  model User {
    id Int @id
    memberships Membership[]
    @@map("public_users")
  }
  model Membership {
    id Int @id
    userId Int
    user User @relation(fields: [userId], references: [id])
    @@map("public_memberships")
  }
}

namespace auth {
  model User {
    id Int @id
    memberships Membership[]
    @@map("auth_users")
  }
  model Membership {
    id Int @id
    userId Int
    user User @relation(fields: [userId], references: [id])
    @@map("auth_memberships")
  }
}
`;
    const result = interpretPslDocumentToSqlContract({
      ...baseInput,
      ...symbolTableInputFromParseArgs({ schema: shared, sourceId: 'schema.prisma' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.failure.diagnostics.map((d) => d.code).join(', '));

    const contract = result.value;
    const publicModels = contract.domain.namespaces['public']?.models as
      | Record<string, ContractModel<SqlModelStorage>>
      | undefined;
    const authModels = contract.domain.namespaces['auth']?.models as
      | Record<string, ContractModel<SqlModelStorage>>
      | undefined;

    expect(publicModels?.['User']?.relations?.['memberships']).toMatchObject({
      cardinality: '1:N',
      to: { namespace: 'public', model: 'Membership' },
    });
    expect(authModels?.['User']?.relations?.['memberships']).toMatchObject({
      cardinality: '1:N',
      to: { namespace: 'auth', model: 'Membership' },
    });
  });

  it('matches each backrelation to the FK side in its own namespace', () => {
    const contract = interpret();

    expect(modelsOf(contract, 'public')?.['User']?.relations?.['profiles']).toMatchObject({
      cardinality: '1:N',
      to: { namespace: 'public', model: 'Profile' },
    });
    expect(modelsOf(contract, 'auth')?.['User']?.relations?.['sessions']).toMatchObject({
      cardinality: '1:N',
      to: { namespace: 'auth', model: 'Session' },
    });
  });
});
