import type { PostgresDriverCreateOptions } from '@internal/driver-postgres/runtime';

/** Server-side cursor for reads. Off unless set; `{ batchSize }` streams rows in batches of that size. */
export type PostgresCursorOptions = NonNullable<PostgresDriverCreateOptions['cursor']>;
