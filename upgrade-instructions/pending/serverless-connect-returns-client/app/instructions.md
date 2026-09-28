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
---

## `serverless-connect-returns-client`

`postgresServerless(...).connect({ url })` used to return a `Runtime`. It now returns a per-request client with the members of a `postgres()` client except `connect`: `sql`, `raw`, `enums`, `nativeEnums`, `context`, `contract`, `stack`, `orm`, `runtime()`, `transaction(fn)`, `prepare(...)`, `close()` and `[Symbol.asyncDispose]`. It is not a `Runtime`: it has no `query` or `execute`. `db.runtime()` returns the runtime. `await using` still closes the connection when the scope ends.

The module-scope client returned by `postgresServerless(...)` still holds no connection. It now also has `raw`, `enums` and `nativeEnums`.

In each file that imports `@prisma/orm-postgres/serverless`, or that uses the result of its `connect()`:

1. Name the module-scope client `postgres` and the result of `connect()` `db`. With these names, code written for a `postgres()` client (`db.orm...`, `db.transaction(...)`, `db.runtime().query(...)`) works unchanged inside a request. Update every import of the module-scope client to the new name.
2. Replace `runtime.query(plan)` with `db.runtime().query(plan)`, and `runtime.execute(plan)` with `db.runtime().execute(plan)`. The old `connect()` result was a full `Runtime`, so the same applies to its other methods: `runtime.connection()`, `runtime.telemetry()` and `runtime.prepare(...)` become `db.runtime().connection()`, `db.runtime().telemetry()` and `db.runtime().prepare(...)`. `db.prepare(...)` also exists and accepts ORM queries as well as SQL plans. `db.sql` is the same object as `postgres.sql`, so `postgres.sql...` inside a request may be written `db.sql...`.
3. Anything that took the `connect()` result as a runtime takes `db.runtime()` instead: `withTransaction(runtime, fn)`, `orm({ runtime, context })`, `preparedStatement.query(runtime, params)`, and your own functions whose parameter is typed `Runtime`. A function that needs both the runtime and the context can take the client, typed with `PostgresServerlessConnection<Contract>` from `@prisma/orm-postgres/serverless`, and read `db.runtime()` and `db.context`. That removes any cast of the module-scope `context` to `ExecutionContext<Contract>`.

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
export const postgres = postgresServerless<Contract>({ contractJson });

// src/orm-client/client.ts
import type { PostgresServerlessConnection } from '@prisma/orm-postgres/serverless';

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
