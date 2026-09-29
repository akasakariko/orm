import type { PostgresDriverCreateOptions } from '@internal/driver-postgres/runtime';

/** Server-side cursor for reads. Off when unset or `{ disabled: true }`; any other value streams rows in batches of `batchSize` (default 100). */
export type PostgresCursorOptions = NonNullable<PostgresDriverCreateOptions['cursor']>;
