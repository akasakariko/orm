import { timeouts, withClient, withDevDatabase } from '@repo/test-utils';
import { describe, expect, it } from 'vitest';
import { canonicalUuidText } from '../src/core/uuid-text';

const spellings = [
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11',
  '{A0EEBC99-9C0B4EF8-BB6D6BB9-BD380A11}',
  'a0eebc999c0b4ef8bb6d6bb9bd380a11',
  'A0EE-BC99-9C0B-4EF8-BB6D-6BB9-BD38-0A11',
  'Not-A-Uuid',
  'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A1',
  'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A111',
  'A0E-EBC99-9C0B-4EF8-BB6D-6BB9BD380A11',
  'A0EEBC99--9C0B-4EF8-BB6D-6BB9BD380A11',
  'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11-',
  '{A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11',
  'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11}',
  ' A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11 ',
  'G0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11',
];

describe('canonicalUuidText against Postgres', () => {
  it(
    'rewrites exactly the spellings Postgres reads as a uuid, into the text Postgres prints',
    async () => {
      await withDevDatabase(async ({ connectionString }) => {
        await withClient(connectionString, async (client) => {
          const printedOrRefusedUnchanged: Record<string, string> = {};
          for (const spelling of spellings) {
            printedOrRefusedUnchanged[spelling] = await client
              .query<{ printed: string }>('SELECT $1::uuid::text AS printed', [spelling])
              .then(
                (result) => result.rows[0]?.printed ?? '',
                () => spelling,
              );
          }
          expect(
            Object.fromEntries(
              spellings.map((spelling) => [spelling, canonicalUuidText(spelling)]),
            ),
          ).toEqual(printedOrRefusedUnchanged);
        });
      });
    },
    timeouts.spinUpPpgDev,
  );
});
