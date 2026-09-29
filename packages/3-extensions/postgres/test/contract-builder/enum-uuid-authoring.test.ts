import type { Contract } from '@internal/contract/types';
import type { SqlStorage } from '@internal/sql-contract/types';
import { describe, expect, it } from 'vitest';
import { defineContract, enumType, member } from '../../src/exports/contract-builder';

const pgUuid = { codecId: 'pg/uuid@1' as const, nativeType: 'uuid' };

describe('uuid-backed enum authoring against the real Postgres pack', () => {
  it('stores upper-case and braced members as the lower-case uuid text Postgres returns', () => {
    const Key = enumType(
      'Key',
      pgUuid,
      member('A', 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'),
      member('B', '{B0EEBC99-9C0B4EF8-BB6D6BB9-BD380A11}'),
    );
    const built = defineContract({ enums: { Key } }, ({ field, model }) => ({
      models: {
        Item: model('Item', {
          fields: { id: field.id.uuidv4String(), key: field.namedType(Key) },
        }),
      },
    }));
    const contract: Contract<SqlStorage> = built;

    expect({
      domainEnum: contract.domain.namespaces['public']?.enum?.['Key'],
      valueSet: contract.storage.namespaces['public']?.entries.valueSet?.['Key'],
      checks: contract.storage.namespaces['public']?.entries.table?.['Item']?.checks?.map(
        (check) => check.expression,
      ),
    }).toEqual({
      domainEnum: {
        codecId: 'pg/uuid@1',
        members: [
          { name: 'A', value: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
          { name: 'B', value: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
        ],
      },
      valueSet: {
        kind: 'valueSet',
        values: ['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
      },
      checks: [
        `"key" IN ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')`,
      ],
    });
  });

  it('refuses two members that store the same uuid, naming both', () => {
    const Key = enumType(
      'Key',
      pgUuid,
      member('Upper', 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'),
      member('Lower', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'),
    );
    expect(() =>
      defineContract({ enums: { Key } }, ({ field, model }) => ({
        models: {
          Item: model('Item', {
            fields: { id: field.id.uuidv4String(), key: field.namedType(Key) },
          }),
        },
      })),
    ).toThrow(
      expect.objectContaining({
        code: 'CONTRACT.ENUM_INVALID',
        message:
          'enumType("Key"): members "Upper" and "Lower" both store "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11". Member values must be unique as the column stores them.',
      }),
    );
  });
});
