# ADR 207 — A serverless Postgres connection has the same query interface as a `postgres()` client

**Status:** Implemented
**Domain:** Adapters / Targets, Runtime

## At a glance

A Node server creates one `db` when the process starts and uses it for every request:

```ts
import { createServer } from 'node:http';
import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from './prisma/contract.d';
import contractJson from './prisma/contract.json' with { type: 'json' };

const db = postgres<Contract>({ contractJson, url: process.env['DATABASE_URL']! });

createServer(async (_request, response) => {
  const posts = await db.orm.public.Post.orderBy((post) => post.createdAt.desc())
    .limit(10)
    .all();
  response.end(JSON.stringify(posts));
}).listen(3000);
```

A Cloudflare Worker opens a new `db` inside each request, and `await using` closes it when the request ends:

```ts
import postgresServerless from '@prisma/orm-postgres/serverless';
import type { Contract } from './prisma/contract.d';
import contractJson from './prisma/contract.json' with { type: 'json' };

interface Env {
  HYPERDRIVE: { connectionString: string };
}

const postgres = postgresServerless<Contract>({ contractJson });

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    await using db = await postgres.connect({ url: env.HYPERDRIVE.connectionString });
    const posts = await db.orm.public.Post.orderBy((post) => post.createdAt.desc())
      .limit(10)
      .all();
    return Response.json(posts);
  },
};
```

The query is the same in both samples. Only the way `db` is obtained differs.

The samples contain three objects. This ADR uses one name for each, and the names match the types in the code:

| Name in this ADR | In the samples | Type | Created by | Lives for |
| --- | --- | --- | --- | --- |
| **client** | `db` in the Node server | `PostgresClient` | `postgres(...)` | the whole process |
| **serverless client** | `postgres` in the Worker | `PostgresServerlessClient` | `postgresServerless(...)` | the whole isolate or function instance |
| **connection** | `db` in the Worker | `PostgresServerlessConnection` | `postgres.connect({ url })` | one request |

A connection owns exactly one database connection, which is one `pg.Client`. Where this ADR means the `pg.Client` and not the object that owns it, it says "database connection".

`@prisma/orm-postgres` is the published package. Inside this repository it is `@internal/postgres`. `postgres()` comes from its `/runtime` entry point and `postgresServerless()` from its `/serverless` entry point.

## Decision

A connection has every member that a client has, except `connect`. Code written against a client's `db` works unchanged against a connection's `db`.

The serverless client holds no database connection and has no member that needs one. It offers the members that are built from the contract alone, and `connect`.

This gives users one rule: inside a request, `db` does everything the `db` from `postgres()` does. `db.orm...`, `db.sql...`, `db.raw...`, `db.transaction(...)`, `db.prepare(...)` and `db.runtime().query(...)` all work. Documentation and examples name the serverless client `postgres` and the connection `db`, so that code taken from a Node application reads the same inside a request.

## Why a Worker cannot share one client

A long-lived process has one lifetime, from start to shutdown. A client creates a `pg.Pool` on first use, and the pool stays valid for all of that lifetime. The pool gives each query a database connection, takes it back afterwards, and replaces database connections that fail. So one client can serve every request.

Cloudflare Workers, AWS Lambda, Vercel functions and Deno Deploy run code per request. An isolate or function instance may handle one request, several in a row, or several at once, and the platform can discard it between requests. The only unit with a clear start and end is the request. A database connection kept at module scope in such a runtime fails in four ways:

- **It goes stale.** After an idle period the network or the database closes the TCP connection, but the object that holds it is still in module scope. The next request uses it and fails with a socket error far from the cause.
- **Concurrent requests share it.** Requests handled at the same time in one isolate share module scope. A `pg.Client` runs one query at a time, so one request's queries wait behind another's. If one request opens a transaction, another request's queries can run inside it.
- **It is never closed.** The end of a request is the moment to close its database connection, but an object at module scope cannot tell when a request ends. The database connection stays open until the isolate is discarded, and counts against the database's connection limit until then.
- **Workers reject it.** Cloudflare Workers do not let a socket opened while handling one request be used while handling another.

A `pg.Pool` per request would avoid the sharing, but a pool is built for a long-lived process. It keeps timers that close idle database connections, and a pool per request would start and stop that work on every request.

So the serverless side follows one rule: nothing that uses a database connection lives longer than a request.

## The three objects and their members

Every member belongs to one of three groups:

| Group | Members | Needs a database connection |
| --- | --- | --- |
| Static members | `sql`, `raw`, `enums`, `nativeEnums`, `context`, `contract`, `stack` | no |
| Runtime-bound members | `orm`, `runtime()`, `transaction(fn)`, `prepare(...)` | yes |
| Lifecycle members | `close()`, `[Symbol.asyncDispose]` | they close it |

The static members build queries and describe the contract. They are computed from the contract and never touch the database. The runtime-bound members run queries. `db.runtime()` returns the runtime, which is the object that executes a query plan; `orm`, `transaction` and `prepare` all run on it.

Each of the three objects has these groups:

| Object | Static | Runtime-bound | Lifecycle | `connect` |
| --- | --- | --- | --- | --- |
| client | yes | yes | yes | yes |
| serverless client | yes | no | no | yes |
| connection | yes | yes | yes | no |

The serverless client has only what is safe at module scope. A connection has everything a client has except `connect`, which it does not need because it is already connected. The static members on a connection are the same objects as the ones on the serverless client that opened it, so they are built once per isolate.

## The lifetime of a connection

`postgres.connect({ url })` opens one `pg.Client`, with no pool, and returns a new connection on every call. It does not change the serverless client.

`await using db = await postgres.connect(...)` closes the connection when the enclosing scope ends, whether the scope returns or throws. Closing ends the `pg.Client`. Calling `close()` or `[Symbol.asyncDispose]` more than once closes it once.

After a connection is closed, `db.runtime()`, ORM queries, `db.transaction(...)` and `db.prepare(...)` fail with the error code `DRIVER.NOT_CONNECTED`.

The `await using` line shows the lifetime of the connection at the place where the connection is opened. A reader can see that it belongs to this request without reading any documentation.

## A connection is not a runtime

A connection wraps a runtime. It is not one: it has no `query` or `execute` of its own. Code that needs a runtime calls `db.runtime()`, exactly as with a client. Three functions take a runtime:

- `orm({ runtime, context, collections })`, which builds an ORM with custom collection classes;
- `withTransaction(runtime, fn)`;
- a prepared statement's `query(runtime, params)`.

This sample and the ones below continue the Worker sample above, so `postgres` is its serverless client and `Contract` is its contract type:

```ts
import { Collection, orm } from '@prisma/orm-postgres/orm-client';

class UserCollection extends Collection<Contract, 'User'> {
  admins() {
    return this.where({ kind: 'admin' });
  }
}

export async function listAdmins(url: string) {
  await using db = await postgres.connect({ url });
  const customOrm = orm({
    runtime: db.runtime(),
    context: db.context,
    collections: { User: UserCollection },
  });
  return await customOrm.public.User.admins().all();
}
```

A custom ORM like this is built inside the request, so that it runs on that request's connection.

## Two rules that follow from one database connection

A client has a pool. A connection has one database connection. Two rules follow for code that uses a connection. Nothing detects a break of either rule when the code runs, so the documentation states both.

### Inside a transaction, every query goes through `tx`

`db.transaction(async (tx) => ...)` holds the connection's only database connection until the callback returns. A call made through `db` inside the callback is therefore not independent of the transaction:

| Call through `db` inside `db.transaction(fn)` | Result on a connection |
| --- | --- |
| a `db.orm` read | runs inside the open transaction |
| a `db.orm` create of a single row | runs inside the open transaction |
| `db.runtime().query(...)` | runs inside the open transaction |
| `db.runtime().connection()` | waits forever, and the request hangs |
| a `db.orm` create that also writes related rows | waits forever, and the request hangs |
| a nested `db.transaction(...)` | waits forever, and the request hangs |

The calls that hang are the ones that ask for a database connection of their own. The transaction holds the only one, so they wait for it, and the transaction waits for them.

On a client, the same calls take another database connection from the pool and run outside the transaction. That is also a mistake, because their writes are not rolled back with the transaction. Sending every query through `tx` is correct on both:

```ts
export async function publish(url: string, email: string, title: string) {
  await using db = await postgres.connect({ url });
  return await db.transaction(async (tx) => {
    const author = await tx.orm.public.User.where({ email }).first();
    if (author === null) throw new Error(`No user with email ${email}`);
    return await tx.orm.public.Post.create({ title, userId: author.id });
  });
}
```

### Every query is awaited before the `await using` scope ends

The connection closes when the scope ends. A query that the scope returns without `await` runs after the connection has closed, and fails with `DRIVER.NOT_CONNECTED`:

```ts
export async function listUsers(url: string) {
  await using db = await postgres.connect({ url });
  return await db.orm.public.User.all();
}
```

Writing `return db.orm.public.User.all()` in this function fails. With a client the version without `await` works, because a client is not closed at the end of each request.

## `connect` on a client and on a serverless client

Both have a method named `connect`, and the two methods do different things.

| | `connect` on a client | `connect` on a serverless client |
| --- | --- | --- |
| Effect | connects that client to its database | opens a new connection and leaves the serverless client unchanged |
| Returns | the client's runtime | the new connection |
| How often | at most once; it fails with `DRIVER.ALREADY_CONNECTED` if the client is already connected or connecting | once per request |
| Required | no; a client created with a `url`, `pg` or `binding` option connects on first use | yes; it is the only way to get a connection |

## Cursors are off by default

`postgres()` and `postgresServerless()` both accept `cursor?: PostgresCursorOptions`, with the same meaning:

- When the option is unset or `{ disabled: true }`, reads use no cursor. The driver fetches the whole result before it returns the first row.
- Any other value, such as `{}` or `{ batchSize: 50 }`, turns cursors on. Reads stream through a server-side cursor in batches of `batchSize` rows, or 100 rows when `batchSize` is omitted.

Streaming suits a request that reads a large result and stops early.

The default is off because, with cursors on, every read hangs behind Cloudflare Hyperdrive. Hyperdrive is the usual way for a Worker to reach a Postgres database other than Prisma Postgres. The hang raises no error: the database connection stops responding, and Cloudflare ends the request after 30 seconds. The [Serverless Deployment Guide](../../Serverless%20Deployment%20Guide.md#known-limitations) records the cause. A read without a cursor works in every deployment.

A Worker that needs streaming on one route creates a second serverless client with the option and opens that route's connection from it. Every other route keeps the serverless client without the option:

```ts
const postgres = postgresServerless<Contract>({ contractJson });
const streamingPostgres = postgresServerless<Contract>({ contractJson, cursor: { batchSize: 100 } });
```

## How the two are kept the same

The three member groups are three interfaces: `PostgresStaticMembers`, `PostgresRuntimeBoundMembers` and `PostgresClientLifecycle`. `PostgresClient` and `PostgresServerlessConnection` both extend all three. A member added to one of the interfaces reaches both. A member added to `PostgresClient` alone does not reach a connection.

Two functions build the members for both:

- `buildPostgresStaticContext` builds `sql`, `raw`, `enums` and `nativeEnums` from the execution context.
- `buildPostgresRuntimeBoundMembers` builds `orm`, `runtime()`, `transaction(fn)` and `prepare(...)`. One of its arguments is a function, `getRuntime`, that returns the runtime to run on.

A client and a connection differ only in what they pass as `getRuntime`. A client passes a function that creates its pool-backed runtime on first use. A connection passes a function that returns the runtime of its one database connection, and throws `DRIVER.NOT_CONNECTED` once the connection is closed.

`postgres()` and `postgresServerless()` take the same options, apart from how they reach the database: `contractJson` or `contract`, `extensions`, `middleware`, `verifyMarker` and `cursor`. `postgres()` also takes `url`, `pg` or `binding`, and `poolOptions`. `postgresServerless()` takes none of those, because the URL is given to each `connect` call. A type test checks that the shared option keys match. Both compose the same execution stack of `postgresTarget`, `postgresAdapter` and `postgresDriver`.

## Consequences

### Benefits

- **One query interface.** Documentation, skills and examples are written once, against `db`. Moving code between a Node server and a per-request runtime changes only how `db` is obtained.
- **The lifetime of a connection is visible where it is opened.** `await using db = await postgres.connect(...)` says that the connection belongs to this scope.
- **No database connection outlives its request.** Nothing can go stale, be shared by concurrent requests, or stay open after its request ends.
- **One implementation of the runtime-bound members.** A client and a connection cannot drift apart.

### Costs

- **The `/serverless` entry point includes the ORM, about 32 kB gzipped.** It is in the bundle even for code that uses only the SQL builder, `db.sql`.
- **The transaction rule and the `await` rule are documented, not enforced.** A break of either fails or hangs when the code runs, with no earlier warning.
- **`connect` has two meanings**, as the table above shows.

## Related ADRs

- [ADR 159 — Runtime Driver Lifecycle](ADR%20159%20-%20Driver%20Terminology%20and%20Lifecycle.md) defines how a driver is created, bound and connected. Each call to `connect` on a serverless client creates a driver and binds it to its own `pg.Client`.
- [ADR 152 — Execution Plane Descriptors and Instances](ADR%20152%20-%20Execution%20Plane%20Descriptors%20and%20Instances.md) defines the descriptor and instance pattern used to compose the execution stack.
- [ADR 242 — Public npm surface](ADR%20242%20-%20Public%20npm%20surface%20-%20single%20@prisma%20scope%20with%20consolidated%20publish%20packages.md) names `@prisma/orm-postgres` and its entry points.

## Alternatives considered

### `connect` returns only a runtime

`postgres.connect({ url })` would return the request's runtime, made disposable, and nothing else. Users would build an ORM with `orm({ runtime, context })` and run transactions with `withTransaction(runtime, fn)`. This would be safe, because nothing would be kept at module scope. But every application would write the same wrapper by hand, in every request, and documented `db.orm...` and `db.transaction(...)` code would need translating before it worked in a request. Documentation would then steer users to call `postgres()` inside each request instead, which builds a `pg.Pool` per request.

### A connection is also a runtime

A connection would carry `query` and `execute` itself, so that it could be passed anywhere a runtime is expected. This would clash in two places. The ORM calls a `transaction()` method with no arguments on its runtime when the runtime has one; on a connection, `transaction` takes a callback, so an ORM write that needs a transaction would call it wrongly. And a runtime has its own `prepare`, with different parameter and return types from a connection's `prepare`, so combining the two in one type would need a type workaround.

### `postgresServerless()` returns only a `connect` function

There would be no serverless client, only a function that opens a connection. Code that needs the static members at module scope, such as a module that builds query plans or reads enum values, would import and configure a second entry point, `@prisma/orm-postgres/static`, with the same contract. Each entry point validates the contract when it is called, so the contract would be validated twice.

### A second serverless entry point without the ORM

A second entry point would offer a connection without `orm`, to save the 32 kB in bundles that do not use it. There would then be two kinds of connection with different abilities, and code written against `db` would work on one and fail on the other.

### Cursors on by default for `postgresServerless()`

Streaming suits per-request runtimes, where memory is small and a request often stops reading early. But with cursors on, every read behind Cloudflare Hyperdrive would hang, with no error, until Cloudflare ended the request. A default that hangs the most common Worker setup would be worse than one that buffers.

### One factory, with a connection opened per request everywhere

There would be no client. Every application, long-lived or not, would open a connection per request with `await using db = await postgres.connect(...)`. The four failures described above do not occur in a long-lived process, where a pool already gives each query a database connection and takes it back. So this would add cost without making anything safer. Opening a `pg.Client` per request would add a handshake to every request, and every route handler would need the extra `await using` line.

### One object at module scope that finds the request's connection through `AsyncLocalStorage`

An object at module scope would have `db.orm` and `db.transaction(...)`, and would look up the current request's runtime in an `AsyncLocalStorage` that the application sets at the start of each request. The lifetime of the database connection would then be invisible where it is used. Code would read like code for a long-lived process but work only if the storage was set, and a missing setup would fail when the code runs, far from its cause. It would save only the `connect` line.

### One factory per product

There would be one factory per product, such as `postgresWorkers` and `postgresLambda`, each with conveniences for that product, for example `postgresWorkers({ hyperdrive: env.HYPERDRIVE })`. The convenience would be small, because every per-request runtime gives the application a connection string: `env.HYPERDRIVE.connectionString` on Workers, `process.env.DATABASE_URL` on Lambda, `Deno.env.get('DATABASE_URL')` on Deno Deploy. A factory per product would save one property access, at the cost of several nearly identical factories. The lifetime rule is the same for every product.
