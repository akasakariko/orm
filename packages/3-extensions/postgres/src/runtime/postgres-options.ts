import type { PostgresDriverCreateOptions } from '@internal/driver-postgres/runtime';
import type {
  SqlMiddleware,
  SqlRuntimeExtensionDescriptor,
  VerifyMarkerOption,
} from '@internal/sql-runtime';
import { ifDefined } from '@internal/utils/defined';
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

export function toDriverCursorOptions(
  cursor: PostgresCursorOptions | undefined,
): NonNullable<PostgresDriverCreateOptions['cursor']> {
  return cursor === undefined ? { disabled: true } : ifDefined('batchSize', cursor.batchSize);
}
