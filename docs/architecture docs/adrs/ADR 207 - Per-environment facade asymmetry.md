# ADR 207 — Per-environment facade asymmetry

**Status:** Implemented
**Date:** 2026-05-01
**Domain:** Adapters / Targets, Runtime

## At a glance

A user writing against `@internal/postgres` picks one of two import paths depending on where their code runs.

In a long-lived Node process:

```ts
import postgres from '@internal/postgres/runtime';
import contractJson from './contract.json' with { type: 'json' };
import type { Contract } from './contract';

const db = postgres<Contract>({ contractJson, url: process.env.DATABASE_URL! });

// Anywhere in the process:
const users = await db.orm.public.User.limit(10).all();
```

In a per-request runtime (Cloudflare Workers, AWS Lambda Node, Vercel Edge / Vercel Serverless, Deno Deploy, Bun edge):

```ts
import postgresServerless from '@internal/postgres/serverless';
import contractJson from './contract.json' with { type: 'json' };
import type { Contract } from './contract';

const postgres = postgresServerless<Contract>({ contractJson });

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    await using db = await postgres.connect({ url: env.HYPERDRIVE.connectionString });
    const users = await db.orm.public.User.limit(10).all();
    return Response.json(users);
  },
};
```

The same package; the same `Contract` type; the same option keys at construction (`contractJson`, `extensions`, `middleware`, `verifyMarker`). Inside a request, `db` does everything the `db` from `postgres()` does. What differs is where the members bound to a connection live. The long-lived client carries them itself, bound to one lazily created pool. The serverless client carries none of them; each `connect({ url })` returns a per-request client that carries them, bound to one fresh `pg.Client`, and `await using` closes it when the request ends.

## Decision

`@internal/postgres` exports two clients. Nothing bound to a connection lives on a client that outlives a request.

- `postgres()` (`@internal/postgres/runtime`) suits long-lived processes. It returns a `PostgresClient`: the static members (`sql`, `raw`, `enums`, `nativeEnums`, `context`, `contract`, `stack`) plus `orm`, `runtime()`, `transaction(fn)`, `prepare(...)`, `connect(...)`, `close()` and `[Symbol.asyncDispose]`. The runtime and its `pg.Pool` are created on first use and live until `close()`.
- `postgresServerless()` (`@internal/postgres/serverless`) suits per-request runtimes. The module-scope client (`PostgresServerlessClient`) has only the static members and `connect({ url })`. It holds no connection. Each `connect({ url })` opens one fresh `pg.Client` and returns a per-request client, `PostgresServerlessConnection`, which is `PostgresClient` without `connect`. Its static members are the same objects as the module-scope client's. `close()` and `[Symbol.asyncDispose]` close its runtime once; after that, `runtime()`, ORM queries, `transaction(...)` and `prepare(...)` fail with `DRIVER.NOT_CONNECTED`.

Both clients build the static members with `buildPostgresStaticContext`, and both build `orm`, `runtime()`, `transaction(fn)` and `prepare(...)` with the same function, `buildPostgresQueryMembers`, from `postgres.ts`. That function takes the execution context, the raw codec inferer, `enums`, `nativeEnums` and a `getRuntime()` function. The clients differ only in what `getRuntime()` returns: the lazily created long-lived runtime, or the runtime of one request's connection. Code written against one client's `db` therefore works on the other's.

The per-request client is not a `Runtime`. It has no `query` or `execute`. Anything that takes a runtime (`orm({ runtime, context, collections })` for custom collection classes, `withTransaction`, a prepared statement's `query(runtime, params)`) receives `db.runtime()`.

Cursor defaults differ to match the dominant per-side shape (off on Node, on under serverless); the serverless factory exposes a `cursor` option.

The two clients compose the same execution stack underneath (`postgresTarget + postgresAdapter + postgresDriver`). The driver layer is the same on both sides.

The remainder explains why two clients, why nothing bound to a connection may live at module scope on the serverless side, and what each difference exists to protect.

## Why two clients, not one

### A long-lived process has one runtime lifetime; the client can match it

A Node process has one beginning and (essentially) one end. A runtime constructed at first use is valid until shutdown: the underlying `pg.Pool` handles connection lifecycle internally, query routing serializes through the pool's checkout and release, and call sites never have to remember to release anything. Caching the runtime inside the client is exactly right for this lifecycle, and so is caching `orm` and `transaction()` over it: `db.orm.public.User.limit(10).all()` reads the way a long-lived API should read.

### A per-request runtime has many short, parallel lifetimes; one cache cannot match them all

A per-request runtime — a Cloudflare Worker, a Lambda invocation, a Vercel Edge function, a Deno Deploy handler, a Bun edge response — has no long-lived process to anchor a runtime to. There is an isolate that may handle one `fetch` invocation, several in succession, several in parallel, or be evicted between them. The natural unit of "one runtime lifetime" is the `fetch` body: it has a clear start (the request arrives) and a clear end (the response is returned, or an error propagates).

Cache a connection at module scope in that environment and three specific things go wrong:

1. **Stale connections after isolate idle.** A cached runtime outlives any single `fetch`. After a minutes-long idle, the underlying TCP connection has been reaped by the network or the origin, but the cached client object is still in scope. The next `fetch` reaches for it and fails with a stale-socket error far from the misconfiguration that caused it.

2. **Head-of-line blocking and cross-`fetch` transaction-state contamination on a shared `pg.Client`.** Multiple `fetch` invocations within one isolate share module scope. `pg.Client` queues queries client-side (FIFO), so concurrent invocations do not race for the wire — they wait. Fetch B's query queues behind fetch A's and only runs after A's response is parsed, defeating the parallelism the runtime is designed to give. Worse, if fetch A opens a transaction with `BEGIN`, fetch B's queries run inside A's transaction until A's `COMMIT` (or `ROLLBACK`) clears it. The Node client avoids this with `pg.Pool`, but `pg.Pool` is itself a long-lived-process construct: background connection reaping, idle eviction, periodic health checks. Constructing a fresh `pg.Pool` per `fetch` would spin up and tear down those background tasks on every request.

3. **No release point.** A `fetch` returning is the natural moment to call `client.end()`, but a module-scope client has no idea a `fetch` returned. The connection lingers until the isolate is evicted. Memory pressure, file-descriptor pressure, or origin-side connection-count limits surface as later, harder-to-diagnose failures.

### What this implies for the serverless client

Reverse the three failure modes and you get the serverless shape:

- The connection is opened per `fetch`, not at module scope. → `postgres.connect({ url })` opens a fresh `pg.Client` per call.
- The connection's lifetime is the `fetch` body. → the per-request client is `AsyncDisposable`; consumers write `await using db = await postgres.connect(...)` and disposal is automatic.
- Members that reach a connection would re-introduce the module-scope cache if they lived on the module-scope client. → they live on the per-request client, each bound to that request's connection.

The static members stay on the module-scope client because they never touch a connection — they are a pure function of the contract — and the per-request client reuses the same objects, so building them once per isolate is a win on both sides.

## What's the same, and what's different

Four concrete differences between the two clients. Each exists to enforce one part of the lifecycle invariant above.

### 1. Static members live at module scope; members bound to a connection live per request

Both sides expose `sql` (the plan builder), `raw`, `enums`, `nativeEnums`, `context`, `contract` and `stack`. None of these reach a connection.

`orm`, `runtime()`, `transaction(fn)` and `prepare(...)` reach a runtime. On the long-lived client they live on the client itself. On the serverless side they live only on the per-request client, so a module-scope `postgres` never holds them and cannot cache a connection by accident. The per-request client has every member the long-lived client has except `connect`, so documentation and code written against `db` from `postgres()` apply to `db` inside a request unchanged.

### 2. `connect()` returns an `AsyncDisposable` per-request client; consumers use `await using`

```ts
await using db = await postgres.connect({ url: env.HYPERDRIVE.connectionString });
const users = await db.orm.public.User.limit(10).all();
// db.close() runs automatically when the fetch body returns
// (including on the throw-and-rethrow path).
```

The per-request client's `[Symbol.asyncDispose]` is its `close()`, which closes the runtime once and ends the underlying `pg.Client`. The long-lived client has no scope at which "the connection is done"; the per-request client does — the `fetch` body. Encoding that scope as an `AsyncDisposable` returned from `connect()` makes the lifetime visible at every call site and makes release impossible to forget.

### 3. ORM and transactions run on the per-request connection

```ts
const posts = await db.orm.public.Post.limit(10).all();

await db.transaction(async (tx) => {
  await tx.execute(/* ... */);
  await tx.orm.public.User.create({ /* ... */ });
});
```

`db.orm` and `db.transaction(fn)` on the per-request client call `getRuntime()` on every query, and that returns the runtime of this request's connection. Nothing is cached at module scope. Custom collection classes still use `orm({ runtime: db.runtime(), context: db.context, collections })` inside the request.

A per-request client has one connection, so inside `db.transaction(async (tx) => ...)` a query through `db` is not independent of the transaction; run every query through `tx`. A query that uses the client's connection directly, such as a `db.orm` read, a single-statement `db.orm` write or `db.runtime().query(...)`, runs inside the open transaction without saying so. An operation that asks for a connection of its own, such as `db.runtime().connection()`, a `db.orm` create that also writes related rows, or a nested `db.transaction(...)`, waits for the connection the transaction holds, and the request hangs.

### 4. Cursor defaults differ to match the dominant per-side shape

The long-lived `postgres()` client defaults `cursor: { disabled: true }`. Long-lived consumers commonly materialize results into containers (arrays, paginated views, batch processors) that benefit from the buffered path's predictability and lower per-row overhead.

The `postgresServerless()` client leaves cursor enabled by default. The dominant per-request shape is "stream a result and return early via `for-await … break`" — exactly what `pg-cursor` is built for, and exactly what isolate memory pressure makes a buffered fetch dangerous for (a 10 000-row result materialized before the first row yields is a foot-gun under any per-request memory budget).

The serverless client exposes a `cursor` option to opt out; the default reflects the dominant shape on each side.

## Consequences

### Positive

- **The lifecycle is visible at the call site.** `await using db = await postgres.connect(...)` reads as "open a connection for this scope; close it when the scope exits". A reviewer can see that the connection is bounded by the `fetch` body without consulting documentation.
- **Stale-connection failures are structurally impossible on the serverless side.** The per-request client cannot outlive its `fetch` in any cache the framework owns. An isolate that handles two `fetch` invocations gets two independent connections.
- **Cross-`fetch` interference is structurally impossible on the serverless side.** Each `fetch` opens its own `pg.Client`. Concurrent invocations within one isolate cannot block on each other's queue or contaminate each other's transaction state.
- **One way to query on both sides.** `db.orm`, `db.sql`, `db.raw`, `db.transaction(...)`, `db.prepare(...)` and `db.runtime().query(...)` mean the same thing inside a request as in a long-lived process. Documentation, skills and examples are written once.
- **One implementation of the query members.** `buildPostgresQueryMembers` builds `orm`, `runtime()`, `transaction()` and `prepare()` for both clients, so they cannot drift apart.
- **Cursor default reflects the dominant shape.** Each side's default fits how that side typically reads results.

### Trade-offs

- **The per-request client builds an ORM client on every `connect()`.** The ORM client is a set of closures over the context and `getRuntime()`, so the cost per request is small, and the serverless bundle includes the ORM client code.
- **A query through `db` inside `db.transaction(fn)` is not independent of the transaction.** Depending on the operation, it runs inside the open transaction without saying so, or it waits for the connection the transaction holds and the request hangs (see § 3). Nothing detects the mistake at run time; documentation states the rule to run every query through `tx`.
- **Two surfaces to keep symmetric at construction.** The same option keys appear on both factories (`contractJson`, `extensions`, `middleware`, `verifyMarker`). A type test checks this, but drift is still possible for keys the test does not name.

## Interaction with other ADRs

- **[ADR 159 — Runtime Driver Lifecycle](ADR%20159%20-%20Driver%20Terminology%20and%20Lifecycle.md)** defines the unbound → bound → connected lifecycle of `SqlDriver`. The serverless client uses that lifecycle unchanged: it constructs a fresh `pg.Client` per `connect()` call and routes through the existing `pgClient` `PostgresBinding` kind, which already implements the per-request shape (lazy `client.connect()`, no `pg.Pool`, explicit `client.end()`, mutex-serialized `acquireConnection` for transaction affinity). No new binding kinds were needed.
- **[ADR 155 — Driver/Codec Boundary and Lowering Responsibilities](ADR%20155%20-%20Driver%20Codec%20Boundary%20and%20Lowering%20Responsibilities.md)** governs the codec/driver/lowering split. Both clients sit above that split and inherit it; the asymmetry is at the client layer, not at the driver layer.
- **[ADR 152 — Execution Plane Descriptors and Instances](ADR%20152%20-%20Execution%20Plane%20Descriptors%20and%20Instances.md)** defines the descriptor/instance pattern that both clients compose (`postgresTarget + postgresAdapter + postgresDriver`). The execution stack is the same on both sides.

## Alternatives considered

### Per-request side offers only a `Runtime`

`connect({ url })` returns the per-request `Runtime`, made `AsyncDisposable`, and nothing else. The ORM client is built per request with `orm({ runtime, context })`, and transactions run through `withTransaction(runtime, fn)`.

**Rejected.** It is safe, because nothing is cached at module scope, but it makes the two sides read differently for no safety gain. Every consumer hand-wrote the same ORM wrapper around the runtime, every documented `db.orm...` and `db.transaction(...)` snippet needed translating before it worked in a request, and the public documentation routed users away from the serverless client because it had no `db.orm`. The argument that holds is against caching connection-bound members at module scope, not against offering them on a per-request object.

### One client, runtime always per-call

Keep one `postgres()` factory; have it return a connection that is *always* per-call. Drop the cached `orm` / `runtime()` / `transaction(...)` from Node too, and require Node consumers to write `await using db = await postgres.connect(...)` per request as well.

**Rejected.** Long-lived processes legitimately benefit from caching: the `pg.Pool` is the right unit of connection lifecycle, the runtime is created once, and the call-site idiom matches the lifetime. Forcing per-call acquisition adds either pool-checkout churn or a layer of indirection that obscures the pooling story, for no safety gain. It would also break every existing Node consumer with no migration story other than "rewrite every route handler".

### One client, `AsyncLocalStorage`-based per-request convenience surface

Keep `db.orm` / `db.transaction(...)` on a module-scope client. Implement them as accessors that read the "current request's runtime" from an `AsyncLocalStorage` set up at the top of `fetch`.

**Rejected.** Three reasons:

1. The lifecycle becomes invisible. Call sites read like the long-lived shape but behave correctly only if the `AsyncLocalStorage` context is set up. Forgetting to set it up surfaces as a runtime error far from the cause.
2. It depends on `node:async_hooks` semantics. That works on Node and on Workers under `nodejs_compat`, but support across other per-request runtimes (Bun, Deno Deploy, edge runtimes that disable Node-compat shims) is uneven.
3. It works against the design intent. The serverless client exists to make the per-request lifecycle *explicit and visible*. `AsyncLocalStorage` exists to make context *implicit and invisible*.

### Per-product clients (`postgresWorkers`, `postgresLambda`, …) instead of per-environment-class

Ship one client per per-request product. Each could carry product-specific ergonomics — e.g. `postgresWorkers({ hyperdrive: env.HYPERDRIVE })` instead of `postgresServerless({ contractJson }) … postgres.connect({ url: env.HYPERDRIVE.connectionString })`.

**Rejected.** Two reasons:

1. The product-specific ergonomic is shallow. Every per-request runtime exposes "a connection string from somewhere" — `env.HYPERDRIVE.connectionString` on Workers, `process.env.DATABASE_URL` on Lambda, `Deno.env.get('DATABASE_URL')` on Deno, etc. Wrapping each in a bespoke factory just to skip a `.connectionString` field access trades a generic surface for N near-identical surfaces with N maintenance footprints.
2. The lifecycle invariants are uniform across products. Per-request is per-request whether the host is Workers or Lambda. Making the API shape track product instead of lifecycle would invite product-specific lifecycle drift.

The per-environment-class shape (one client, one shape, sourced URL) reflects the actual invariant.
