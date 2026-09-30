import type { ColumnDefaultLiteralInputValue } from '@internal/contract/types';
import type { CodecRef } from '@internal/framework-components/codec';
import { describe, expect, it } from 'vitest';
import { createPostgresBuiltinCodecLookup } from '../src/core/codec-registry';
import { renderLiteralDefaultSql } from '../src/core/literal-default-sql';

const codecs = createPostgresBuiltinCodecLookup();

function render(
  value: ColumnDefaultLiteralInputValue,
  nativeType: string,
  codecRef: CodecRef | undefined,
): Promise<string> {
  return renderLiteralDefaultSql(value, nativeType, codecRef, codecs);
}

describe('renderLiteralDefaultSql', () => {
  it('writes a bytea default as the bytes its base64 text encodes', async () => {
    expect(await render('aGVsbG8=', 'bytea', { codecId: 'pg/bytea@1' })).toBe(
      "'\\x68656c6c6f'::bytea",
    );
  });

  it('writes a bigint default from the decimal text the contract stores', async () => {
    expect(await render('9007199254740993', 'int8', { codecId: 'pg/int8@1' })).toBe(
      "'9007199254740993'::int8",
    );
  });

  it('writes a date or time default as its date and time text', async () => {
    expect({
      interval: await render('P1DT2H', 'interval', { codecId: 'pg/interval@1' }),
      beforeChrist: await render('-000043-03-15T00:00:00Z', 'timestamptz', {
        codecId: 'pg/timestamptz-temporal@1',
      }),
    }).toEqual({
      interval: "'P1DT2H'::interval",
      beforeChrist: "'0044-03-15T00:00:00Z BC'::timestamptz",
    });
  });

  it('writes a Date default without reading it as JSON', async () => {
    expect(
      await render(
        new Date('2025-06-01T00:00:00.000Z') as unknown as ColumnDefaultLiteralInputValue,
        'timestamptz',
        { codecId: 'pg/timestamptz-date@1' },
      ),
    ).toBe("'2025-06-01T00:00:00.000Z'::timestamptz");
  });

  it('writes the value as given when the column has no codec', async () => {
    expect({
      withoutRef: await render('aGVsbG8=', 'bytea', undefined),
      unregistered: await render('aGVsbG8=', 'bytea', { codecId: 'unregistered@1' }),
    }).toEqual({
      withoutRef: "'aGVsbG8='::bytea",
      unregistered: "'aGVsbG8='::bytea",
    });
  });

  describe('a list default', () => {
    it('writes each bytea element as the bytes its base64 text encodes', async () => {
      expect(await render(['aGVsbG8='], 'bytea[]', { codecId: 'pg/bytea@1', many: true })).toBe(
        "ARRAY['\\x68656c6c6f'::bytea]::bytea[]",
      );
    });

    it('writes each jsonb element as a JSON document, a string element included', async () => {
      expect(await render([{ a: 1 }, 'x'], 'jsonb[]', { codecId: 'pg/jsonb@1', many: true })).toBe(
        `ARRAY['{"a":1}'::jsonb, '"x"'::jsonb]::jsonb[]`,
      );
    });

    it('writes each interval element as its date and time text', async () => {
      expect(
        await render(['P1DT2H', 'PT-0.5S'], 'interval[]', {
          codecId: 'pg/interval@1',
          many: true,
        }),
      ).toBe("ARRAY['P1DT2H'::interval, 'PT-0.5S'::interval]::interval[]");
    });

    it('writes a null element as NULL', async () => {
      expect(
        await render(['aGVsbG8=', null], 'bytea[]', { codecId: 'pg/bytea@1', many: true }),
      ).toBe("ARRAY['\\x68656c6c6f'::bytea, NULL]::bytea[]");
    });

    it('writes a Date element without reading it as JSON', async () => {
      expect(
        await render(
          [new Date('2025-06-01T00:00:00.000Z')] as unknown as ColumnDefaultLiteralInputValue,
          'timestamptz[]',
          { codecId: 'pg/timestamptz-date@1', many: true },
        ),
      ).toBe("ARRAY['2025-06-01T00:00:00.000Z'::timestamptz]::timestamptz[]");
    });

    it('writes an empty list as the empty array text', async () => {
      expect(await render([], 'bytea[]', { codecId: 'pg/bytea@1', many: true })).toBe("'{}'");
    });

    it('writes the elements as given when the column has no codec', async () => {
      expect(await render(['aGVsbG8='], 'bytea[]', { codecId: 'unregistered@1', many: true })).toBe(
        "ARRAY['aGVsbG8=']::bytea[]",
      );
    });

    it('refuses a malformed element with the codec error', async () => {
      await expect(
        render(['aGVsbG8=', 'not base64!'], 'bytea[]', { codecId: 'pg/bytea@1', many: true }),
      ).rejects.toMatchObject({
        code: 'RUNTIME.DECODE_FAILED',
        message: 'pg/bytea@1 database JSON value must be a base64 string',
      });
    });
  });
});
