import type { PostgresDriverCreateOptions } from '@internal/driver-postgres/runtime';
import type {
  SqlMiddleware,
  SqlRuntimeExtensionDescriptor,
  VerifyMarkerOption,
} from '@internal/sql-runtime';
import { ifDefined } from '@internal/utils/defined';
import { type } from 'arktype';
import { postgresError } from '../errors';
import type { PostgresTargetId } from './postgres-target-id';

/** Server-side cursor for reads. Unset reads the whole result before the first row; set streams rows in batches of `batchSize`, 100 when omitted. */
export interface PostgresCursorOptions {
  readonly batchSize?: number;
}

/** The options `postgres()` and `postgresServerless()` share: how queries run, not where the database is. */
export interface PostgresExecutionOptions {
  readonly extensions?: readonly SqlRuntimeExtensionDescriptor<PostgresTargetId>[];
  readonly middleware?: readonly SqlMiddleware[];
  readonly verifyMarker?: VerifyMarkerOption;
  readonly cursor?: PostgresCursorOptions;
}

const cursorOptionsSchema = type({ 'batchSize?': 'number.integer > 0' }).onUndeclaredKey('reject');

export function validateCursorOptions(
  cursor: PostgresCursorOptions | undefined,
  helper: 'postgres' | 'postgresServerless',
): PostgresCursorOptions | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  const result = cursorOptionsSchema(cursor);
  if (result instanceof type.errors) {
    throw postgresError('RUNTIME.ARGUMENT_INVALID', 'Invalid cursor option', {
      why: result.summary,
      fix: 'Pass cursor: {} or cursor: { batchSize: <positive integer> } to read through a server-side cursor, or leave cursor unset to read without one.',
      meta: { extension: 'postgres', helper, argument: 'cursor', received: cursor },
    });
  }
  return result;
}

export function toDriverCursorOptions(
  cursor: PostgresCursorOptions | undefined,
): NonNullable<PostgresDriverCreateOptions['cursor']> {
  return cursor === undefined ? { disabled: true } : ifDefined('batchSize', cursor.batchSize);
}
