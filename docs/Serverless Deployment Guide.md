# Serverless Deployment Guide

How to deploy Prisma 8 to per-request runtimes — Cloudflare Workers + Hyperdrive as the primary worked path, with pointers for AWS Lambda (Node), Vercel Edge / Vercel Serverless, Deno Deploy, and Bun edge.

This guide covers the per-request facade `@internal/postgres/serverless`. If you are deploying to a long-lived Node process (a server, a container, a non-edge Vercel function with bundling that keeps the process warm), use the existing `@internal/postgres/runtime` facade — the long-lived shape is unchanged and not in scope here.

## Two facades, one driver

`@internal/postgres` exports two facades that compose the same execution stack and differ only in lifecycle ergonomics:

| Surface                                           | `db = postgres()` — `/runtime`        | `postgres = postgresServerless()` — `/serverless`                   |
| ------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| Lifecycle                                         | Long-lived process                    | Per-request invocation                                              |
| `sql`, `raw`, `enums`, `nativeEnums`              | on `db`                               | on `postgres` and on each per-request `db` (the same objects)       |
| `context`, `contract`, `stack`                    | on `db`                               | on `postgres` and on each per-request `db` (the same objects)       |
| `orm`, `runtime()`, `transaction()`, `prepare()`  | on `db`, bound to one lazy pool       | on the per-request `db` from `postgres.connect({ url })` only       |
| Cursor default                                    | off; `cursor: { batchSize }` streams  | off; `cursor: { batchSize }` streams                                |
| Disposal                                          | `db.close()` at process shutdown      | `await using db = await postgres.connect(...)` closes per request   |

The static members are the same on both sides. They are a pure function of the contract, so they are safe to build once per isolate. Everything bound to a connection differs in where it lives: `postgres()` keeps it on the long-lived client, and `postgresServerless()` puts it on a per-request client returned by `connect({ url })`. That per-request client has the members of a `postgres()` client except `connect`. See [ADR 207 — Long-lived and per-request Postgres clients share one query interface](./architecture%20docs/adrs/ADR%20207%20-%20Long-lived%20and%20per-request%20Postgres%20clients%20share%20one%20query%20interface.md) for the architectural rationale and the rejected alternatives.

The practical version: caching a connection (the `pg.Client` inside a runtime) at module scope across `fetch` invocations is two flavors of unsafe in per-request runtimes — stale-connection failures after isolate idle, and concurrent-`fetch` races on a single shared `pg.Client`. The serverless facade makes the lifetime explicit at every call site:

```ts
export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    await using db = await postgres.connect({ url: env.HYPERDRIVE.connectionString });
    const users = await db.orm.public.User.all();
    // db.close() runs automatically when the fetch body returns
    // (including on the throw-and-rethrow path).
    return Response.json(users);
  },
};
```

Inside a request, `db` does everything the `db` from `postgres()` does, so any documented `db.orm...`, `db.sql...`, `db.raw...`, `db.transaction(...)`, `db.prepare(...)` or `db.runtime().query(...)` snippet works unchanged. Await every query before the `await using` scope ends: the connection closes when the scope ends, so a query returned from the scope without `await` (`return db.orm...` instead of `return await db.orm...`) fails with a "not connected" error. Never call `connect` at module scope.

## Cloudflare Workers + Hyperdrive (worked example)

Cloudflare Workers + [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) is the primary tested path. Hyperdrive is Cloudflare's managed Postgres connection pooler at the edge: the Worker connects to it with the standard Postgres wire protocol via the `pg` library, Hyperdrive terminates that connection at the edge and pools connections to your origin Postgres. The Worker reads the connection string off `env.HYPERDRIVE.connectionString`.

A complete worked example lives at `examples/prisma-8-cloudflare-worker/`. This section documents the pattern; the example documents the example.

### Architecture

```
┌─────────────────┐      ┌────────────────┐      ┌─────────────────┐
│ Worker isolate  │ ───→ │   Hyperdrive   │ ───→ │ Origin Postgres │
│ (per fetch)     │  pg  │ (edge pooler)  │  pg  │ (PPg, RDS, ...) │
│ connect() opens │      │   pgbouncer-   │      │                 │
│ one pg.Client   │      │   equivalent   │      │                 │
└─────────────────┘      └────────────────┘      └─────────────────┘
        ▲                                                 ▲
        │                                                 │
        │ runtime queries                       Node-side migrations
        │ (per fetch)                           run from Node directly
        │                                       against the origin URL,
        │                                       NOT through Hyperdrive
        │                                       (see Migrations below).
```

The runtime path goes Worker → Hyperdrive → origin. The control-plane (migrations) path goes Node → origin directly.

### Setup

#### 1. Provision the origin

Any Postgres-compatible origin works (Prisma Postgres / PPg, AWS RDS, Neon, Supabase, etc.). Hyperdrive holds the origin credentials; the Worker never sees them.

#### 2. Provision Hyperdrive

```bash
pnpm exec wrangler hyperdrive create my-hyperdrive \
  --connection-string="postgres://USER:PASS@HOST:PORT/DBNAME"
```

Wrangler prints a binding ID. Wire it into `wrangler.jsonc`:

```jsonc
{
  "name": "my-worker",
  "main": "src/worker.ts",
  "compatibility_date": "2025-07-18",
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "<the-id-printed-by-wrangler-hyperdrive-create>"
    }
  ]
}
```

`nodejs_compat` is required: the Postgres driver (`pg`) uses several Node built-ins that workerd polyfills under that flag. The M1 audit confirmed `pg` + `pg-cursor` work under `nodejs_compat` end-to-end (open / read / cursor early-break / close) when validated against a localhost Postgres origin and against `vitest-pool-workers`'s miniflare emulator — i.e., paths that do not put real Hyperdrive in front of the origin.

> **Production caveat — read this before deploying.** Against real Hyperdrive, reads with cursors on hang (`pg-cursor`'s extended-query named portal trips a Hyperdrive parser bug — full diagnostic in the [Reads with cursors on hang on Cloudflare Hyperdrive](#known-limitations) entry below). Cursors are off by default; until the upstream fix lands, do not turn them on behind Hyperdrive. The miniflare emulator and localhost Postgres paths above don't reproduce the hang, so the example's local tests pass with cursors on — the bug only surfaces against a real deployed Hyperdrive config.

#### 3. Local dev

For `wrangler dev` and `vitest-pool-workers`, the Hyperdrive binding needs a local connection string. Wrangler reads it from a `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING_NAME>` environment variable in `.env` ([Cloudflare docs](https://developers.cloudflare.com/hyperdrive/configuration/local-development)). For a binding named `HYPERDRIVE`:

```bash
# .env (gitignored)
WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://user:pass@127.0.0.1:5432/mydb"
```

This goes in `.env`, not `.dev.vars`. `.dev.vars` is for runtime worker secrets; the `WRANGLER_*_LOCAL_CONNECTION_STRING_*` variable is consumed by Wrangler itself when it builds the Hyperdrive binding for local dev. The `WRANGLER_*` prefix is being deprecated in favour of `CLOUDFLARE_*` in newer Wrangler — both work as of `wrangler@4.87`.

### Worker code shape

Module-scope construction; a per-request client from `connect`; SQL, ORM and transactions on that client; cursor streaming. The full file is `examples/prisma-8-cloudflare-worker/src/worker.ts`.

#### Module scope

```ts
// src/prisma/db.ts
import postgresServerless from '@internal/postgres/serverless';
import type { Contract } from './contract.d';
import contractJson from './contract.json' with { type: 'json' };

// Constructed once per isolate. Holds no connection: only the static
// members (sql / raw / enums / nativeEnums / context / contract / stack),
// which are pure functions of the contract. Each fetch gets its own
// client from postgres.connect(...).
export const postgres = postgresServerless<Contract>({
  contractJson,
  // middleware: [...],   // optional — telemetry, lints, budgets, ...
  // extensions: [...],   // optional
  // cursor: { batchSize: 100 },  // optional — stream reads in batches. Off by
                                  // default. Do not turn on behind Cloudflare
                                  // Hyperdrive — see Production caveat above.
});
```

#### Per request

```ts
// src/worker.ts
import { postgres } from './prisma/db';

interface Env {
  HYPERDRIVE: { connectionString: string };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Fresh client per fetch, with its own pg.Client. When the fetch body
    // returns (or throws), db.close() runs and ends the pg.Client. No
    // shared connection across concurrent fetches in this isolate.
    await using db = await postgres.connect({ url: env.HYPERDRIVE.connectionString });

    const url = new URL(request.url);

    // SQL DSL plan — db.runtime().query returns the rows.
    if (url.pathname === '/sql/users') {
      const rows = await db.runtime().query(
        db.sql.public.user.select('id', 'email').limit(10).build(),
      );
      return Response.json(rows);
    }

    // ORM — db.orm runs on this request's connection.
    if (url.pathname === '/orm/posts') {
      const rows = await db.orm.public.Post.orderBy((post) => post.createdAt.desc()).limit(10).all();
      return Response.json(rows);
    }

    // Transactions — BEGIN/COMMIT/ROLLBACK happen on this request's
    // pg.Client. Run every query inside the callback through tx.
    if (url.pathname === '/tx/example') {
      const result = await db.transaction(async (tx) => {
        await tx.execute(db.sql.public.user.update({ /* ... */ }).where(/* ... */).build());
        await tx.execute(db.sql.public.post.insert([{ /* ... */ }]).build());
        return { ok: true };
      });
      return Response.json(result);
    }

    return new Response('not found', { status: 404 });
  },
};
```

#### Cursor streaming

Reads are buffered by default. To stream, pass `cursor: { batchSize: 100 }` to `postgresServerless({...})`; the driver then reads through `pg-cursor` in batches of that size:

```ts
export const postgres = postgresServerless<Contract>({
  contractJson,
  cursor: { batchSize: 100 },
});
```

With cursors on, the `for-await ... break` shape exits early without materializing the rest of the result; the cursor closes cleanly on `break`:

```ts
if (url.pathname === '/cursor/large') {
  const consumed: { id: string; title: string }[] = [];
  // Bounded SELECT (see budgets middleware). Cursor-on means the driver
  // opens a server-side cursor and streams ~100-row batches — early
  // break only fetches one batch and closes the cursor. Cursor-off
  // would buffer all 10_000 rows before yielding the first one.
  const iter = db.runtime().query(
    db.sql.public.post.select('id', 'title').orderBy((f) => f.createdAt, { direction: 'asc' }).limit(10_000).build(),
  );
  for await (const row of iter) {
    consumed.push(row);
    if (consumed.length >= 50) break;
  }
  return Response.json({ consumed: consumed.length });
}
```

Both facades default to cursors off and accept the same `cursor` option. Turn cursors on where a request streams a large result and returns early, because isolate memory pressure makes buffering a 10k-row result before yielding the first row a foot-gun. Do not turn them on behind Cloudflare Hyperdrive.

### Wiring the ORM client

`db.orm` is the default way to use the ORM on the per-request client. When you register custom collection classes, build an ORM client from the per-request client's runtime and context:

```ts
// src/orm-client/client.ts
import { orm } from '@internal/sql-orm-client';
import type { PostgresServerlessConnection } from '@internal/postgres/serverless';
import type { Contract } from '../prisma/contract.d';
import { PostCollection, UserCollection } from './collections';

export function createOrmClient(
  db: Pick<PostgresServerlessConnection<Contract>, 'runtime' | 'context'>,
) {
  return orm({
    runtime: db.runtime(),
    context: db.context,
    collections: {
      User: UserCollection,
      Post: PostCollection,
    },
  }).public;
}

// in fetch:
// const rows = await createOrmClient(db).User.newestFirst().limit(10).all();
```

Pass `db.runtime()` to `orm()`, not `db` itself. The same holds for anything else that takes a runtime, such as `withTransaction` and a prepared statement's `query(runtime, params)`. Call the factory inside `fetch`, so the ORM client runs on that request's connection.

## Other per-request runtimes

The `postgresServerless` facade is generic across per-request runtimes. The only thing that differs per runtime is how you source the connection string — the facade itself is environment-shaped, not Cloudflare-product-shaped.

This guide does not ship worked examples or CI for non-Cloudflare runtimes. The pattern is identical; only the connection-string source changes.

| Runtime                    | Connection-string source                                              |
| -------------------------- | --------------------------------------------------------------------- |
| AWS Lambda (Node)          | `process.env.DATABASE_URL` (set via Lambda env vars / secrets layer)  |
| Vercel Serverless (Node)   | `process.env.DATABASE_URL`                                            |
| Vercel Edge                | `process.env.DATABASE_URL` (per Vercel edge runtime conventions)      |
| Deno Deploy                | `Deno.env.get('DATABASE_URL')`                                        |
| Bun edge                   | `process.env.DATABASE_URL` (Bun's Node-compat env shim)               |

The Worker code shape is the same on all of them: module-scope `postgres = postgresServerless({...})`, per-request `await using db = await postgres.connect({ url: <sourced URL> })`. Hyperdrive is Cloudflare-specific; on other runtimes the URL points directly at the origin or at whatever pooler your platform exposes (RDS Proxy on Lambda, Vercel Postgres pooler, etc.).

## Migrations

Migrations stay on Node, against the **origin** database connection string (not Hyperdrive).

There is no per-request migration story and there is no Hyperdrive control-plane driver. The reasons:

- Migration commands (`prisma db migrate`, `prisma db init`) are control-plane operations: they speak to the `migration` plane through the control-plane Postgres driver, run in long-lived Node processes (CI runners, dev workstations, deploy hooks), and are inherently long-lived shapes — DDL does not benefit from per-request lifecycle.
- Hyperdrive caches query results at the edge. That is desirable for many runtime read patterns and undesirable for DDL: a stale read of the migration ledger or marker leads to duplicate-apply or skipped-apply confusion. The Cloudflare-recommended pattern is to bypass Hyperdrive for control-plane operations, and we follow that.

The existing migration commands accept a connection string (typically via `DATABASE_URL`) and use the `@internal/driver-postgres/control` driver. Run them from CI / your deploy pipeline / a one-shot Node task pointed at the origin URL — see the existing migration docs and the [Getting Started guide](./onboarding/Getting-Started.md) for the command surface. Nothing about deploying to a per-request runtime changes that.

## Known limitations

- **Inside a transaction, run every query through `tx`.** A per-request client has one connection, so inside `db.transaction(async (tx) => ...)` a query through `db` is not independent of the transaction; run every query through `tx`. A query that uses the client's connection directly, such as a `db.orm` read, a single-statement `db.orm` write or `db.runtime().query(...)`, runs inside the open transaction without saying so. An operation that asks for a connection of its own, such as `db.runtime().connection()`, a `db.orm` create that also writes related rows, or a nested `db.transaction(...)`, waits for the connection the transaction holds, and the request hangs. A second client opened inside the callback with `await using db2 = await postgres.connect(...)` has its own connection, so statements sent through it are not part of the transaction.

- **Isolate memory limits.** Workers isolates have bounded memory (128 MiB by default; higher on Workers Unbound). ORM `findMany`-style operations materialize the result set into a JS array before returning; `limit(...)` is your hard memory cap on those. If you need to stream, pass `cursor: { batchSize }` and use the SQL DSL with `db.runtime().query(...)` — the iterator then reads through a cursor and yields rows as they arrive, with `for-await ... break` cancelling cleanly without buffering the rest of the result set. Not behind Cloudflare Hyperdrive; see the next entry.

- **Reads with cursors on hang on Cloudflare Hyperdrive — cursors are off by default; do not turn them on if your origin sits behind Hyperdrive.** Empirically verified during the May 2026 production smoke. The cursor path uses `pg-cursor`'s extended-query named-portal protocol; after rows are returned and the client sends `Close portal + Sync`, Hyperdrive emits `Protocol Error: Unexpected protocol code: C` (SQLSTATE `58000`) and never follows up with the expected `ReadyForQuery`. The connection wedges; Cloudflare's runtime kills the request at 30 s with error 1101. With cursors on, this affects every read path (SQL DSL, ORM `.all()` / `.first()`, `for await`) — there is no per-call short-circuit, the cursor decision is made at the driver layer for every read. Wrapping the read in `db.transaction(...)` does not help: the failure is in Hyperdrive's protocol parser state, not in connection pinning. The driver's catch-block fallback to simple-query mode does **not** save you either — it only fires on certain thrown errors, and a hang doesn't throw. Workaround: leave the `cursor` option unset behind Hyperdrive, so reads take the buffered path. Tracking upstream as a Cloudflare Hyperdrive bug.

- **The `@internal/postgres` package statically imports `pg-pool` and `pg-cloudflare`.** The serverless facade does not construct a `pg.Pool` and does not exercise the pool path, but the `pg` library imports both at module load. The bundle includes them. This is not a correctness concern — `pg-cloudflare` activates only when `navigator.userAgent === 'Cloudflare-Workers'` is true at runtime — but it adds bundle weight. The example's full bundle measures around 254 KiB gzipped including these.

- **Migrations run from Node.** As above — no per-request migration story, no Hyperdrive control-plane driver. If your deploy pipeline expects to apply migrations from the same surface that runs the Worker, you need a separate Node task (CI step, deploy hook, one-shot script).

## Validating end-to-end

The `examples/prisma-8-cloudflare-worker/` example provides a `vitest-pool-workers` integration test that boots the Worker under `workerd`, points the Hyperdrive binding at a local Docker Postgres, and exercises SQL DSL, ORM, transactions, and cursor streaming. That suite is the canonical "does my pattern work end-to-end" reference and is the one you should mirror when bootstrapping your own deployment.

The example is intentionally minimal — minimum schema, minimum routes — so you can compare your setup against it side-by-side. See its README for the local-dev workflow (`pnpm db:up` / `pnpm db:init` / `pnpm seed` / `pnpm dev`) and the bundle-size / cold-start measurements.

## See also

- [ADR 207 — Long-lived and per-request Postgres clients share one query interface](./architecture%20docs/adrs/ADR%20207%20-%20Long-lived%20and%20per-request%20Postgres%20clients%20share%20one%20query%20interface.md) — the architectural rationale for the two-facade design.
- [ADR 159 — Runtime Driver Lifecycle](./architecture%20docs/adrs/ADR%20159%20-%20Driver%20Terminology%20and%20Lifecycle.md) — how the underlying driver lifecycle works (both facades inherit it unchanged).
- [Architecture Overview](./Architecture%20Overview.md) — Prisma 8's broader plane / target / adapter / driver model.
- [Cloudflare Hyperdrive docs](https://developers.cloudflare.com/hyperdrive/) — Hyperdrive setup, configuration, and observability.
- The example: `examples/prisma-8-cloudflare-worker/` (in this repo).
