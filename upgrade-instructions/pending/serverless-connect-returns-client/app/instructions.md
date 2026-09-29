---
changes:
  - id: serverless-connect-returns-client
    summary: "connect({ url }) on the client from @prisma/orm-postgres/serverless returns a per-request client, not a Runtime. Call db.runtime().query(plan) and db.runtime().execute(plan), and pass db.runtime() wherever the connect() result was used as a runtime."
    detection:
      glob: "**/*.{ts,mts,cts,tsx}"
      matches:
        - '[''"]@prisma/orm-postgres/serverless[''"]'
  - id: serverless-client-orm-and-transaction
    summary: "Optional: the per-request client has orm and transaction(fn), so db.orm replaces a hand-built orm({ runtime, context }) in queries that call no custom collection method, and db.transaction(fn) replaces withTransaction(runtime, fn)."
    detection:
      glob: "**/*.{ts,mts,cts,tsx}"
      matches:
        - '[''"]@prisma/orm-postgres/serverless[''"]'
  - id: serverless-cursor-default-off
    summary: "Reads through the client from @prisma/orm-postgres/serverless no longer go through a server-side cursor by default. A path that must keep batched streaming connects through a second client with cursor: { batchSize: 100 }; that path hangs behind Cloudflare Hyperdrive. PostgresServerlessCursorOptions is now PostgresCursorOptions."
    detection:
      glob: "**/*.{ts,mts,cts,tsx}"
      matches:
        - '[''"]@prisma/orm-postgres/serverless[''"]'
---

## `serverless-connect-returns-client`

`postgresServerless(...).connect({ url })` used to return a `Runtime`. It now returns a per-request client with the members of a `postgres()` client except `connect`: `sql`, `raw`, `enums`, `nativeEnums`, `context`, `contract`, `stack`, `orm`, `runtime()`, `transaction(fn)`, `prepare(...)`, `close()` and `[Symbol.asyncDispose]`. It is not a `Runtime`: it has no `query` or `execute`. `db.runtime()` returns the runtime. `await using` still closes the connection when the scope ends.

The module-scope client returned by `postgresServerless(...)` still holds no connection. It now also has `raw`, `enums` and `nativeEnums`.

In each file that imports `@prisma/orm-postgres/serverless`, or that uses the result of its `connect()`:

1. Name the module-scope client `postgres` and the result of `connect()` `db`. With these names, code written for a `postgres()` client (`db.orm...`, `db.transaction(...)`, `db.runtime().query(...)`) works unchanged inside a request, as long as every query is awaited before the `await using` scope ends: the connection closes when the scope ends, so a query returned from the scope without `await` fails with a "not connected" error. Update every import of the module-scope client to the new name.
2. Replace `runtime.query(plan)` with `db.runtime().query(plan)`, and `runtime.execute(plan)` with `db.runtime().execute(plan)`. The old `connect()` result was a full `Runtime`, so the same applies to its other methods: `runtime.connection()`, `runtime.telemetry()` and `runtime.prepare(...)` become `db.runtime().connection()`, `db.runtime().telemetry()` and `db.runtime().prepare(...)`. `db.prepare(...)` also exists and accepts ORM queries as well as SQL plans. `db.sql` is the same object as `postgres.sql`, so `postgres.sql...` inside a request may be written `db.sql...`.
3. Anything that took the `connect()` result as a runtime takes `db.runtime()` instead: `withTransaction(runtime, fn)`, `orm({ runtime, context })`, `preparedStatement.query(runtime, params)`, and your own functions whose parameter is typed `Runtime`. A function that needs both the runtime and the context can take the client, typed with `PostgresServerlessConnection<Contract>` from `@prisma/orm-postgres/serverless`, and read `db.runtime()` and `db.context`. That removes any cast of the module-scope `context` to `ExecutionContext<Contract>`, and the `Runtime`, `ExecutionContext` and module-scope client imports that only served it.
4. Update comments that describe the old shape. A comment that names the old variable or says the runtime is acquired through `db.connect(...)` now names `postgres.connect({ url })` and the per-request `db`. For example, the doc comment on the module-scope client says that it is built once per isolate, holds no connection, and that each request gets its own client from `postgres.connect({ url })`; it sits directly above the `postgresServerless(...)` declaration, so move it there if it sits above another declaration. Update any README that describes the old shape in the same way.

Before:

```ts
// src/prisma/db.ts
export const db = postgresServerless<Contract>({ contractJson });

// src/orm-client/client.ts
import type { Runtime } from '@prisma/orm-postgres/family-runtime';
import type { ExecutionContext } from '@prisma/orm-postgres/relational-core/query-lane-context';
import { db } from '../prisma/db';

const context = db.context as ExecutionContext<Contract>;

export function createOrmClient(runtime: Runtime) {
  return orm({ runtime, context, collections: { User: UserCollection } }).public;
}

// src/worker.ts
import { db } from './prisma/db';

await using runtime = await db.connect({ url: env.HYPERDRIVE.connectionString });
const rows = await runtime.query(db.sql.public.user.select('id').build());
const users = await createOrmClient(runtime).User.newestFirst().all();
```

After:

```ts
// src/prisma/db.ts
/**
 * Module-scope client, built once per isolate. It holds no connection. Each request gets its own client from `postgres.connect({ url })`.
 */
export const postgres = postgresServerless<Contract>({ contractJson });

// src/orm-client/client.ts
import { orm } from '@prisma/orm-postgres/orm-client';
import type { PostgresServerlessConnection } from '@prisma/orm-postgres/serverless';
import type { Contract } from '../prisma/contract.d';
import { UserCollection } from './collections';

export function createOrmClient(
  db: Pick<PostgresServerlessConnection<Contract>, 'runtime' | 'context'>,
) {
  return orm({
    runtime: db.runtime(),
    context: db.context,
    collections: { User: UserCollection },
  }).public;
}

// src/worker.ts
import { postgres } from './prisma/db';

await using db = await postgres.connect({ url: env.HYPERDRIVE.connectionString });
const rows = await db.runtime().query(db.sql.public.user.select('id').build());
const users = await createOrmClient(db).User.newestFirst().all();
```

The same applies to scripts that connect through the serverless client, for example a seed script: `await using db = await postgres.connect({ url })`, then `db.runtime().execute(...)`.

## `serverless-client-orm-and-transaction`

This change is optional. The per-request client builds an ORM client and runs transactions itself.

- For each query on a hand-built `orm({ runtime, context })` client, check whether it calls a method defined on a custom collection class. If it calls none, run it on `db.orm` instead, even when the hand-built client registers custom collections, and drop the hand-built client from that code path when nothing else there uses it. For example, `const orm = createOrmClient(db); const rows = await orm.Post.where({ userId }).all();` becomes `const rows = await db.orm.public.Post.where({ userId }).all();`. Keep the hand-built client, built from `db.runtime()` and `db.context`, for queries that call custom collection methods, such as `orm.User.newestFirst()`.
- Replace `withTransaction(runtime, async (tx) => ...)` with `db.transaction(async (tx) => ...)`. `tx` has the same `execute` and `query` as before, plus `tx.sql`, `tx.orm`, `tx.enums` and `tx.nativeEnums`. Remove the `withTransaction` import when nothing else uses it.

Before:

```ts
import { withTransaction } from '@prisma/orm-postgres/family-runtime';

await using runtime = await db.connect({ url });
const posts = await orm({ runtime, context }).public.Post.where({ userId }).all();
await withTransaction(runtime, async (tx) => {
  await tx.execute(db.sql.public.user.update({ displayName }).where((f, fns) => fns.eq(f.id, userId)).build());
});
```

After:

```ts
await using db = await postgres.connect({ url });
const posts = await db.orm.public.Post.where({ userId }).all();
await db.transaction(async (tx) => {
  await tx.execute(db.sql.public.user.update({ displayName }).where((f, fns) => fns.eq(f.id, userId)).build());
});
```

## `serverless-cursor-default-off`

`postgresServerless()` used to read through `pg-cursor` in batches of 100 rows unless you passed `cursor: { disabled: true }`. Reads are now buffered by default, the same as on `postgres()`: the whole result arrives before the first row is yielded.

1. Find the paths that rely on batched streaming, for example `for await` over a large result with an early `break`. Leave the client every other path uses without a `cursor` option; those paths now buffer. To keep a streaming path streaming, give it its own module-scope client, for example `streamingPostgres`, created with the same options as the client the other paths use (such as `middleware` and `extensions`) plus `cursor: { batchSize: 100 }`, and connect through that client only on that path, so each request still opens one connection. Document on that client that it is used only by that path and that reads through it hang behind Cloudflare Hyperdrive. Behind real Cloudflare Hyperdrive that path hangs, because reads with cursors on hang there; the other paths do not. If the path must work behind real Hyperdrive, do not create the second client and accept buffered reads on it instead. Never put the `cursor` option on the client every path uses.
2. Remove `cursor: { disabled: true }` from `postgresServerless(...)` options. It is now the default.
3. Replace the type `PostgresServerlessCursorOptions` with `PostgresCursorOptions`, exported from `@prisma/orm-postgres/serverless` and `@prisma/orm-postgres/runtime`.
4. Update comments and README text that say the serverless client streams through a cursor by default. Say which paths use the streaming client, and that those paths hang behind real Cloudflare Hyperdrive while the other paths do not.

A streaming path, before:

```ts
// src/prisma/db.ts
export const postgres = postgresServerless<Contract>({ contractJson });

// src/worker.ts, in fetch; the /cursor/large path streams with `for await` and breaks early
await using db = await postgres.connect({ url: env.HYPERDRIVE.connectionString });
```

After:

```ts
// src/prisma/db.ts
export const postgres = postgresServerless<Contract>({ contractJson });

/**
 * Module-scope client with cursors on, used only by the `/cursor/large` route to stream a large result. Reads through it hang behind Cloudflare Hyperdrive.
 */
export const streamingPostgres = postgresServerless<Contract>({
  contractJson,
  cursor: { batchSize: 100 },
});

// src/worker.ts
import { postgres, streamingPostgres } from './prisma/db';

// in fetch
const routeClient = url.pathname === '/cursor/large' ? streamingPostgres : postgres;
await using db = await routeClient.connect({ url: env.HYPERDRIVE.connectionString });
```

`cursor: { disabled: true }` and the old type, before:

```ts
import postgresServerless, {
  type PostgresServerlessCursorOptions,
} from '@prisma/orm-postgres/serverless';

const cursor: PostgresServerlessCursorOptions = { disabled: true };

export const postgres = postgresServerless<Contract>({ contractJson, cursor });
```

After:

```ts
import postgresServerless from '@prisma/orm-postgres/serverless';

export const postgres = postgresServerless<Contract>({ contractJson });
```
