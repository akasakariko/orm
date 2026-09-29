# ADR 207 — Long-lived and per-request Postgres clients share one query interface

**Status:** Implemented
**Domain:** Adapters / Targets, Runtime

`@prisma/orm-postgres` has two client factories. Inside this repository the package is `@internal/postgres`.

- `postgres()`, from `@prisma/orm-postgres/runtime`, is for long-lived processes such as a Node server. The application creates the client once, and the client holds a connection pool for the life of the process.
- `postgresServerless()`, from `@prisma/orm-postgres/serverless`, is for runtimes that run code per request: Cloudflare Workers, AWS Lambda, Vercel functions and Deno Deploy.

## Decision

Both clients give users the same query interface. On the serverless side, that interface lives on a per-request client that `connect({ url })` returns, and nothing bound to a connection lives on an object that outlives a request.

A Node server creates one client and uses it everywhere:

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

A Worker creates a module-scope client that holds no connection. Each request opens its own client, and `await using` closes it when the request ends:

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

The query is the same in both samples. This is the rule users are taught: inside a request, `db` does everything the `db` from `postgres()` does. Documented `db.orm...`, `db.sql...`, `db.raw...`, `db.transaction(...)`, `db.prepare(...)` and `db.runtime().query(...)` code works unchanged. The one member the per-request client lacks is `connect`, which it does not need. Documentation and examples name the module-scope serverless client `postgres` and the per-request client `db`, so that code taken from a Node application reads the same inside a request.

The rest of this ADR describes the shape of the two clients, why the serverless side keeps connections out of module scope, the rules that follow from having one connection per request, and the default for cursors.

## The shape of the two clients

The members of both clients come from three interfaces, declared in `packages/3-extensions/postgres/src/runtime/postgres-runtime-bound-members.ts`:

| Interface | Members | Uses a connection |
| --- | --- | --- |
| `PostgresStaticMembers` | `sql`, `raw`, `enums`, `nativeEnums`, `context`, `contract`, `stack` | no |
| `PostgresRuntimeBoundMembers` | `orm`, `runtime()`, `transaction(fn)`, `prepare(...)` | yes |
| `PostgresClientLifecycle` | `close()`, `[Symbol.asyncDispose]` | closes it |

Each client type combines them:

| Type | Returned by | Members |
| --- | --- | --- |
| `PostgresClient` | `postgres(...)` | all three interfaces, plus `connect` |
| `PostgresServerlessClient` | `postgresServerless(...)` | the static members, plus `connect` |
| `PostgresServerlessConnection` | `connect({ url })` on a `PostgresServerlessClient` | all three interfaces |

`PostgresClient` and `PostgresServerlessConnection` extend the same three interfaces. A member added to one of the interfaces therefore reaches both clients. A member added to `PostgresClient` alone does not reach the per-request client.

Both clients build their members with the same two functions:

- `buildPostgresStaticContext` builds `sql`, `raw`, `enums` and `nativeEnums` from the execution context.
- `buildPostgresRuntimeBoundMembers` builds `orm`, `runtime()`, `transaction(fn)` and `prepare(...)`. It takes the execution context, the raw codec inferer, `enums`, `nativeEnums` and a `getRuntime` function that returns the runtime to run on.

The clients differ only in what `getRuntime` returns. On `postgres()`, it returns the one runtime the client creates on first use. On the per-request client, it returns the runtime of that request's connection, and throws `DRIVER.NOT_CONNECTED` once the client is closed. Because one function builds the runtime-bound members for both clients, the two cannot drift apart.

Both factories take the same construction options, apart from how they reach the database: `contractJson` or `contract`, `extensions`, `middleware`, `verifyMarker` and `cursor`. `postgres()` also takes `url`, `pg` or `binding`, and `poolOptions`. The serverless client takes a URL in each `connect` call instead. A type test checks that the shared option keys match. Underneath, both clients compose the same execution stack of `postgresTarget`, `postgresAdapter` and `postgresDriver`, so every difference between them is in the client layer.

## Nothing bound to a connection outlives a request

A long-lived process has one lifetime, from start to shutdown. A `pg.Pool` created on first use stays valid for all of it. The pool gives each query a connection, takes the connection back afterwards, and replaces connections that fail. So the long-lived client can keep its runtime, and the `orm` and `transaction` members that use it, for as long as the process runs.

A per-request runtime has no such lifetime. An isolate or function instance may handle one request, several in a row or several at once, and it can be discarded between requests. The unit with a clear start and end is the request. A connection kept at module scope in that environment fails in four ways:

- **Stale connections.** After an idle period the network or the database closes the TCP connection, but the object that holds it is still in module scope. The next request uses it and fails with a socket error far from the cause.
- **Concurrent requests share one client.** Requests handled at the same time in one isolate share module scope. A `pg.Client` runs one query at a time, so one request's queries wait behind another's. If one request opens a transaction, another request's queries can run inside it. A `pg.Pool` would avoid this, but a pool is built for a long-lived process: it keeps timers that close idle connections, so a pool per request would start and stop that work on every request.
- **No clean shutdown.** The end of a request is the moment to close its connection, but a module-scope client cannot tell when a request ends. The connection stays open until the isolate is discarded, and counts against the database's connection limit until then.
- **Workers reject it.** Cloudflare Workers do not let a socket opened while handling one request be used while handling another. A connection kept at module scope fails on the next request.

The serverless client therefore follows one rule: nothing bound to a connection lives on an object that outlives a request.

- The module-scope client, `PostgresServerlessClient`, holds only the static members and `connect`. The static members are built from the contract and never use a connection, so they are built once per isolate, and every per-request client shares the same objects.
- `postgres.connect({ url })` opens one `pg.Client`, with no pool, and returns a new `PostgresServerlessConnection` on every call.
- `await using db = await postgres.connect(...)` closes the per-request client when the scope ends, whether the scope returns or throws. Closing ends the `pg.Client`. The runtime is closed once, however many times `close()` or `[Symbol.asyncDispose]` is called. After that, `db.runtime()`, ORM queries, `db.transaction(...)` and `db.prepare(...)` fail with `DRIVER.NOT_CONNECTED`.

The `await using` line also shows the lifetime of the connection where the connection is opened. A reader can see that the connection belongs to this request without reading any documentation.

## The per-request client is not a `Runtime`

The per-request client wraps a runtime. It is not one: it has no `query` or `execute` of its own. Anything that takes a runtime receives `db.runtime()`, exactly as with a `postgres()` client:

- `orm({ runtime, context, collections })`, which builds an ORM client with custom collection classes;
- `withTransaction(runtime, fn)`;
- a prepared statement's `query(runtime, params)`.

This sample and the ones below continue the Worker sample above, so `postgres` is its module-scope client and `Contract` its contract type:

```ts
import { Collection, orm } from '@prisma/orm-postgres/orm-client';

class UserCollection extends Collection<Contract, 'User'> {
  admins() {
    return this.where({ kind: 'admin' });
  }
}

export async function listAdmins(url: string) {
  await using db = await postgres.connect({ url });
  const client = orm({
    runtime: db.runtime(),
    context: db.context,
    collections: { User: UserCollection },
  });
  return await client.public.User.admins().all();
}
```

Build such an ORM client inside the request, so that it runs on that request's connection.

## What `connect` means on each client

`connect` does different things on the two clients. On `postgres()`, `connect(binding?)` connects that client to its database and returns the client's runtime. It is optional, because a client built with a `url`, `pg` or `binding` option connects on first use, and it fails with `DRIVER.ALREADY_CONNECTED` when the client is already connected or connecting. On the module-scope serverless client, `connect({ url })` opens a new per-request client on every call and leaves the module-scope client unchanged. The shared name is a known inconsistency; renaming either method is a separate decision.

## One connection per request

A per-request client has one connection. Two rules follow from that. Nothing detects a break of either rule at run time, so the documentation states both.

### Inside a transaction, every query goes through `tx`

`db.transaction(async (tx) => ...)` holds the request's only connection until the callback returns. A query sent through `db` inside the callback is not independent of the transaction. This is what each kind of call does, as measured:

| Call through `db` inside `db.transaction(fn)` | Result |
| --- | --- |
| a `db.orm` read | runs inside the open transaction |
| a `db.orm` create of a single row | runs inside the open transaction |
| `db.runtime().query(...)` | runs inside the open transaction |
| `db.runtime().connection()` | waits for the connection the transaction holds, and the request hangs |
| a `db.orm` create that also writes related rows | waits, and the request hangs |
| a nested `db.transaction(...)` | waits, and the request hangs |

The calls that hang are the ones that ask for a connection of their own. An ORM create that writes related rows runs its statements in a transaction on a connection from `connection()`, and so does a nested `db.transaction(...)`. On a `postgres()` client the same calls take another connection from the pool and run outside the transaction. Sending every query through `tx` is correct on both clients:

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

### Every query is awaited inside the `await using` scope

The connection closes when the scope ends. A query that the scope returns without `await` runs after the connection has closed, and fails with `DRIVER.NOT_CONNECTED`:

```ts
export async function listUsers(url: string) {
  await using db = await postgres.connect({ url });
  return await db.orm.public.User.all();
}
```

Writing `return db.orm.public.User.all()` in this function fails. On a `postgres()` client the version without `await` works, because that client is not closed at the end of each request.

## Cursors are off by default on both clients

Both factories accept `cursor?: PostgresCursorOptions`. When the option is unset or `{ disabled: true }`, both clients read without a cursor: the driver fetches the whole result before it returns the first row. Any other value, such as `{}` or `{ batchSize: 50 }`, turns cursors on: reads on either client stream through a server-side cursor in batches of `batchSize` rows, or 100 rows when `batchSize` is omitted. Streaming suits a request that reads a large result and stops early.

```ts
const postgres = postgresServerless<Contract>({ contractJson, cursor: { batchSize: 100 } });
```

The default is off because, with cursors on, every read hangs behind Cloudflare Hyperdrive, and Hyperdrive is the usual way for a Worker to reach a Postgres database other than Prisma Postgres. The hang raises no error: the connection stops responding, and Cloudflare ends the request after 30 seconds. The [Serverless Deployment Guide](../../Serverless%20Deployment%20Guide.md#known-limitations) records the protocol-level cause. A buffered read works in every deployment, so it is the default for both clients.

## Consequences

### Benefits

- **One query interface.** Documentation, skills and examples are written once, against `db`. Moving code between a Node server and a per-request runtime changes only how `db` is created.
- **The lifetime of a connection is visible where it is opened.** `await using db = await postgres.connect(...)` says that the connection belongs to this scope.
- **No connection outlives its request.** Each request opens and closes its own `pg.Client`. The serverless client keeps no connection that could go stale, be shared by concurrent requests, or stay open after its request ends.
- **One implementation of the runtime-bound members.** `buildPostgresRuntimeBoundMembers` builds them for both clients.

### Costs

- **The serverless entry includes the ORM client, about 32 kB gzipped.** It is in the bundle even for code that uses only the SQL builder, `db.sql`.
- **The transaction and `await` rules are documented, not enforced.** A query through `db` inside a transaction, or a query not awaited inside the `await using` scope, fails or hangs at run time with no earlier warning.

## Related ADRs

- [ADR 159 — Runtime Driver Lifecycle](ADR%20159%20-%20Driver%20Terminology%20and%20Lifecycle.md) defines how a driver is created, bound and connected. Each serverless `connect` creates a driver and binds it to its own `pg.Client` through the `pgClient` binding kind.
- [ADR 152 — Execution Plane Descriptors and Instances](ADR%20152%20-%20Execution%20Plane%20Descriptors%20and%20Instances.md) defines the descriptor and instance pattern that both clients use to compose the execution stack.
- [ADR 242 — Public npm surface](ADR%20242%20-%20Public%20npm%20surface%20-%20single%20@prisma%20scope%20with%20consolidated%20publish%20packages.md) names `@prisma/orm-postgres` and its entry points.

## Alternatives considered

### The per-request side offers only a `Runtime`

`connect({ url })` would return the request's `Runtime`, made disposable, and nothing else. Users would build the ORM client with `orm({ runtime, context })` and run transactions with `withTransaction(runtime, fn)`. This would be safe, because nothing would be kept at module scope. But every application would write the same ORM wrapper by hand, in every request, and documented `db.orm...` and `db.transaction(...)` code would need translating before it worked in a request. Documentation would then steer users to create a full `postgres()` client inside each request instead, which builds a `pg.Pool` per request.

### The per-request client is also a `Runtime`

The per-request client would carry `query` and `execute` itself, so that it could be passed anywhere a runtime is expected. This would clash in two places. The ORM client calls a `transaction()` method with no arguments on its runtime when the runtime has one; on the per-request client, `transaction` takes a callback, so an ORM write that needs a transaction would call it wrongly. And `Runtime` has its own `prepare`, with different parameter and return types from the client's `prepare`, so combining the two in one type would need a type workaround. `db.runtime()` stays the one way to reach the runtime, as on `postgres()`.

### `postgresServerless()` returns a bare connect function

`postgresServerless()` would return only a function that opens a per-request client. Code that needs the static members at module scope as well as per-request clients, such as a module that builds query plans or reads enum values, would import and configure a second entry point, `@prisma/orm-postgres/static`, with the same contract. Each factory validates the contract when it is called, so the contract would be validated twice.

### A second serverless entry point without the ORM client

A second entry point would offer a per-request client without `orm`, to save the 32 kB of the ORM client in bundles that do not use it. It would mean two per-request interfaces with different abilities, and code written against `db` would work on one and fail on the other.

### Cursors on by default for the serverless client

Streaming suits per-request runtimes, where memory is small and a request often stops reading early. But with cursors on, every read behind Cloudflare Hyperdrive would hang, with no error, until Cloudflare ended the request. A default that hangs the most common Worker setup would be worse than one that buffers, so streaming is opt-in.

### One client whose connection is always opened per request

There would be one factory, and every application, long-lived or not, would open a connection per request with `await using db = await postgres.connect(...)`. The failures described above do not occur in a long-lived process, where a pool already gives each query a connection and takes it back, so this would add cost without making anything safer. Opening a `pg.Client` per request would add a connection handshake to every request. Taking one connection from a pool per request would hold that connection for the whole request instead of for each query. Every route handler would also need the extra `await using` line.

### One client with an `AsyncLocalStorage`-based per-request interface

A module-scope client would keep `db.orm` and `db.transaction(...)`, and look up the current request's runtime in an `AsyncLocalStorage` that the application sets at the start of each request. The lifetime of the connection would then be invisible at the call site. Code would read like long-lived code but work only if the storage was set, and a missing setup would fail at run time, far from its cause. In exchange it would save only the `connect` line, because the per-request client already offers the same interface.

### Per-product clients

There would be one client per product, such as `postgresWorkers` and `postgresLambda`, each with product-specific conveniences, for example `postgresWorkers({ hyperdrive: env.HYPERDRIVE })`. The convenience would be small: every per-request runtime gives the application a connection string, from `env.HYPERDRIVE.connectionString` on Workers, `process.env.DATABASE_URL` on Lambda, or `Deno.env.get('DATABASE_URL')` on Deno Deploy. A factory per product would save one property access, at the cost of several nearly identical factories to maintain. The lifetime rules are also the same for every product, so an interface split by product would invite the products' connection handling to drift apart.
