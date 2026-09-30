import type { ColumnDefaultLiteralInputValue } from '@internal/contract/types';
import type { Codec, CodecLookup, CodecRef } from '@internal/framework-components/codec';
import { materializeCodec } from '@internal/framework-components/codec';
import { isPostgresDateTimeDataType, postgresDateTimeDdlText } from './date-time-ddl-text';
import { postgresError } from './errors';
import { renderDefaultLiteral } from './migrations/planner-ddl-builders';
import { escapeLiteral } from './sql-utils';

/**
 * The SQL literal a column default writes, read through the column's codec. `nativeType` is the
 * column type as DDL writes it, with `[]` for a list. A list writes each element through the
 * element codec. A column whose codec the lookup does not hold writes the value as given.
 */
export async function renderLiteralDefaultSql(
  value: ColumnDefaultLiteralInputValue,
  nativeType: string,
  codecRef: CodecRef | undefined,
  codecLookup: CodecLookup,
): Promise<string> {
  const codec = columnCodec(codecLookup, codecRef);
  const dataTypeId =
    codecRef === undefined ? undefined : codecLookup.descriptorFor?.(codecRef.codecId)?.dataType;
  if (Array.isArray(value) && nativeType.endsWith('[]')) {
    const elementCodec = codecRef?.many === true ? codec : undefined;
    if (elementCodec === undefined || value.length === 0) {
      return renderDefaultLiteral(value, { many: true, nativeType, dataTypeId });
    }
    const elementType = nativeType.slice(0, -2);
    const elements = await Promise.all(
      value.map((element: ColumnDefaultLiteralInputValue) =>
        element === null ? 'NULL' : codecLiteral(element, elementCodec, dataTypeId, elementType),
      ),
    );
    return `ARRAY[${elements.join(', ')}]::${nativeType}`;
  }
  if (codec !== undefined) {
    return codecLiteral(value, codec, dataTypeId, nativeType);
  }
  return inlineLiteral(value, nativeType);
}

/**
 * Builds the column's codec with the column's own `typeParams`: a parameterized codec answers for
 * them when it reads a default back — `pg/vector@1` checks the length its column declares — and the
 * lookup's representative instance carries none.
 */
function columnCodec(codecLookup: CodecLookup, codecRef: CodecRef | undefined): Codec | undefined {
  if (codecRef === undefined) return undefined;
  const descriptor = codecLookup.descriptorFor?.(codecRef.codecId);
  return descriptor === undefined
    ? codecLookup.get(codecRef.codecId)
    : materializeCodec(descriptor, codecRef, { name: codecRef.codecId });
}

/**
 * A literal default reaches here either as the canonical JSON a contract stores or as the value an
 * authoring surface built, and only the first needs reading back: `pg/int8@1` stores decimal text
 * for a `bigint`, which `encode` does not take. A `Date` is the one authored value JSON has no
 * notation for, so it is the one that arrives as itself.
 */
async function codecLiteral(
  value: ColumnDefaultLiteralInputValue,
  codec: Codec,
  dataTypeId: string | undefined,
  nativeType: string,
): Promise<string> {
  if (typeof value === 'string' && isPostgresDateTimeDataType(dataTypeId)) {
    return inlineLiteral(postgresDateTimeDdlText(value, dataTypeId), nativeType);
  }
  const decoded = value instanceof Date ? value : codec.decodeJson(value);
  return inlineLiteral(await codec.encode(decoded, {}), nativeType);
}

function isTextLikeNativeType(nativeType: string): boolean {
  return (
    nativeType === 'text' ||
    nativeType === 'varchar' ||
    nativeType.startsWith('varchar(') ||
    nativeType === 'character varying' ||
    nativeType.startsWith('character varying(') ||
    nativeType === 'char' ||
    nativeType.startsWith('char(') ||
    nativeType === 'character' ||
    nativeType.startsWith('character(')
  );
}

function inlineLiteral(wire: unknown, nativeType: string): string {
  if (wire === null) return 'NULL';
  if (typeof wire === 'boolean') return wire ? 'true' : 'false';
  if (typeof wire === 'number') {
    if (!Number.isFinite(wire)) {
      throw postgresError(
        'CONTRACT.DEFAULT_INVALID',
        `A non-finite number wire value ${String(wire)} cannot be emitted as a DEFAULT literal for native type "${nativeType}"`,
        { meta: { nativeType } },
      );
    }
    return String(wire);
  }
  if (typeof wire === 'bigint') return String(wire);
  if (wire instanceof Date) {
    if (Number.isNaN(wire.getTime())) {
      throw postgresError(
        'CONTRACT.DEFAULT_INVALID',
        `An invalid Date value cannot be emitted as a DEFAULT literal for native type "${nativeType}"`,
        { meta: { nativeType } },
      );
    }
    const quoted = `'${escapeLiteral(wire.toISOString())}'`;
    return isTextLikeNativeType(nativeType) ? quoted : `${quoted}::${nativeType}`;
  }
  if (typeof wire === 'string') {
    const quoted = `'${escapeLiteral(wire)}'`;
    return isTextLikeNativeType(nativeType) ? quoted : `${quoted}::${nativeType}`;
  }
  if (wire instanceof Uint8Array) {
    const hex = Array.from(wire)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `'\\x${hex}'::${nativeType}`;
  }
  if (typeof wire === 'object') {
    const quoted = `'${escapeLiteral(JSON.stringify(wire))}'`;
    return `${quoted}::${nativeType}`;
  }
  throw postgresError(
    'CONTRACT.PACK_CONTRIBUTION_INVALID',
    `An unexpected wire type "${typeof wire}" cannot be emitted as a DEFAULT literal for native type "${nativeType}"`,
    { meta: { wireType: typeof wire, nativeType } },
  );
}
