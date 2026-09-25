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

function refusalFor(schema: string): readonly { code: string; message: string }[] {
  const result = interpretPslDocumentToSqlContract({
    ...baseInput,
    ...symbolTableInputFromParseArgs({ schema, sourceId: 'schema.prisma' }),
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('interpretation unexpectedly succeeded');
  return result.failure.diagnostics.map(({ code, message }) => ({ code, message }));
}

describe('who speaks for an unusable relation target', () => {
  it('leaves a sibling-namespace target to the binder alone', () => {
    expect(
      refusalFor(`namespace public {
  model Post {
    id Int @id
    userId Int
    user User @relation(fields: [userId], references: [id])
  }
}

namespace auth {
  model User {
    id Int @id
  }
}
`),
    ).toEqual([
      { code: 'PSL_UNRESOLVED_REFERENCE', message: 'Cannot find type "User"' },
      {
        code: 'PSL_UNRESOLVED_REFERENCE',
        message: 'Cannot find field "id" on the type of "Post.user"',
      },
    ]);
  });

  it('leaves a qualified target naming no namespace to the binder, which names it', () => {
    expect(
      refusalFor(`namespace public {
  model Post {
    id Int @id
    userId Int
    user wrong.User @relation(fields: [userId], references: [id])
  }
}

namespace auth {
  model User {
    id Int @id
  }
}
`),
    ).toEqual([
      { code: 'PSL_UNRESOLVED_REFERENCE', message: 'Cannot find type "wrong.User"' },
      {
        code: 'PSL_UNRESOLVED_REFERENCE',
        message: 'Cannot find field "id" on the type of "Post.user"',
      },
    ]);
  });

  it('names a bare type reference into an unavailable extension namespace', () => {
    expect(
      refusalFor(`model Document {
  id Int @id
  embedding pgvector.Vector
}
`),
    ).toEqual([
      { code: 'PSL_UNRESOLVED_REFERENCE', message: 'Cannot find type "pgvector.Vector"' },
      {
        code: 'PSL_UNSUPPORTED_FIELD_TYPE',
        message: 'Field "Document.embedding" type "Vector" is not supported in SQL PSL provider v1',
      },
    ]);
  });

  it('reports a resolved-but-non-model target itself, naming what it found', () => {
    expect(
      refusalFor(`type Address {
  street String
}

model Post {
  id Int @id
  addressId Int
  address Address @relation(fields: [addressId], references: [street])
}
`),
    ).toEqual([
      {
        code: 'PSL_INVALID_RELATION_TARGET',
        message:
          'Relation field "Post.address" references composite type "Address"; a relation target must be a model',
      },
    ]);
  });
});
