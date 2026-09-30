# TML-2419 spike: a query returned without `await` from an `await using` scope

Branch `tml-2398-serverless-client-symmetry`, commit `3addefc903`. Measured against Docker Postgres 16 (the `examples/prisma-8-cloudflare-worker` container on port 5433, seeded with `pnpm db:init && pnpm seed`), Node 26.8.1, built `dist/` of every package (no source newer than dist). Probes and their full output are in this folder: `probe.ts` + `run-probes.sh` → `probe-output.txt`; `node-only.ts` and `poison.ts` → `probe-output-2.txt`. The container is stopped and the example `.env` is deleted again.

## Summary

Symptom 1, the wrong error. The serverless connection checks "closed" when a query is built, but the runtime does the work when the query is awaited. `db.orm.public.User.all()` calls `getRuntime().query(plan)` at once and returns a lazy thenable; the scope closes; the caller's `await` then starts the generator, which reads the contract marker through the driver. The driver's unbound wrapper has already set its delegate to `null` in `close()`, and every entry point of that wrapper reports a `null` delegate with the "not connected. Call connect(binding)" message, without looking at its own `#closed` flag. The marker reader wraps any error that is not a `CliStructuredError` as `CONTRACT.MARKER_READ_FAILED`.

Symptom 2, the unhandled rejection. `db.transaction()`, `db.orm...first()` and `db.runtime().execute()` return real promises and start work immediately. The scope's disposal calls `runtime.close()`, which makes the driver unusable synchronously and then waits for `pg.Client.end()`, an I/O turn. The in-flight promise rejects a few microtasks later, while disposal is still waiting for the socket. The async function hands that promise to its caller only after disposal finishes. Node reports a rejected promise with no handler once the microtask queue is empty, which happens before the socket closes. With Node's default `--unhandled-rejections=throw` the process exits with code 1 (probe `NO_HANDLER=1 tsx probe.ts tx`: exit code 1).

The pooled `postgres()` client has the same shape of bug with a different error: `close()` ends the pool but never closes the runtime or driver, so a query built before `close()` and awaited after it fails inside pg-pool with a plain `Error: Cannot use a pool after calling end on the pool` (no error code), wrapped as `CONTRACT.MARKER_READ_FAILED` on the first query.

## Probe results

`tsx probe.ts <case> [noverify] [warm]`. Every case runs in a fresh process. "noverify" passes `verifyMarker: false`; "warm" awaits one query inside the scope first. The dispose wrapper logs when disposal starts and ends, and the `unhandledRejection` handler logs whether disposal was still running.

| Case (serverless, `await using`) | Caller gets | Unhandled rejection |
| --- | --- | --- |
| `return await db.orm.public.User.all()` (correct) | 2 rows | no |
| `return db.orm.public.User.all()` | `CONTRACT.MARKER_READ_FAILED`, cause `DRIVER.NOT_CONNECTED` "Postgres driver not connected. Call connect(binding)…" | no |
| same, `verifyMarker: false` | bare `DRIVER.NOT_CONNECTED`, same message | no |
| same, after an awaited query | bare `DRIVER.NOT_CONNECTED`, same message | no |
| `return db.orm.public.User.first()` | `CONTRACT.MARKER_READ_FAILED` | **yes**, while disposal runs |
| `return db.transaction(async tx => (await tx.orm.public.User.all()).length)` | `CONTRACT.MARKER_READ_FAILED` | **yes**, while disposal runs |
| same, `verifyMarker: false` | **a value (2)**: the transaction commits | no |
| same, after an awaited query | **a value (2)** | no |
| `return db.transaction(async tx => tx.execute(update))` | `CONTRACT.MARKER_READ_FAILED` | **yes** |
| `return db.runtime().query(plan)` | `CONTRACT.MARKER_READ_FAILED` | no |
| `return db.runtime().execute(plan)` | `CONTRACT.MARKER_READ_FAILED` | **yes** |
| same, `verifyMarker: false` | bare `DRIVER.NOT_CONNECTED` | **yes** |
| `return db.prepare({}, () => plan)` | a prepared statement (resolves) | no |

| Case (pooled `postgres()`, `close()` while a promise is pending) | Caller gets | Unhandled rejection |
| --- | --- | --- |
| `const p = db.orm.public.User.all(); await db.close(); return p` | `CONTRACT.MARKER_READ_FAILED`, why "Cannot use a pool after calling end on the pool", cause a plain `Error` | no |
| same, after an awaited query | plain `Error: Cannot use a pool after calling end on the pool`, no code | no |
| `const p = db.transaction(...); await db.close(); return p` | `CONTRACT.MARKER_READ_FAILED` (pg-pool cause) | **yes**, while `close()` is pending |
| `const p = db.runtime().execute(plan); await db.close(); return p` | `CONTRACT.MARKER_READ_FAILED` (pg-pool cause) | no |

`node-only.ts` has no Prisma code. A promise that rejects while an `await using` disposal waits on a timer is reported as unhandled and then "handled asynchronously"; the same rejection held until the disposal has finished is not reported at all. This is the mechanism behind symptom 2 and the mechanism the fix uses.

`poison.ts` makes one driver-level query fail with a simulated transient error on a pooled client. All three following ORM reads fail with `CONTRACT.MARKER_READ_FAILED` although only one driver query was made to fail: the runtime keeps the rejected marker-verification promise for ever.

## Q1. Where does the unhandled rejection come from?

The promise that is created and not observed is the one the user's `return` hands out: the promise from `withTransaction` (`packages/2-sql/5-runtime/src/sql-runtime.ts:976`), from `consumeFirstRow` for `orm.first()` (`packages/3-extensions/sql-orm-client/src/collection-dispatch.ts:332-335`), or from `executeStatisticsAgainstQueryable` for `runtime().execute()` (`sql-runtime.ts:538`). Nothing inside the runtime leaks a promise: `verifyMarkerPromise` is awaited at `sql-runtime.ts:377`, `withTransaction` awaits everything it starts, and the driver's `unboundQuery` only throws from `next()`.

Timeline for `return db.transaction(fn)` with default options:

1. `db.transaction(fn)` → `withTransaction(getRuntime(), …)` (`packages/3-extensions/postgres/src/runtime/postgres-members.ts:107`). `getRuntime()` returns the runtime because `closing` is still `undefined` (`postgres-serverless.ts:171-176`). `withTransaction` calls `runtime.connection()` → `driver.acquireConnection()`; the direct driver takes its connection lease synchronously (`packages/3-targets/7-drivers/postgres/src/postgres-driver.ts:714`, `AsyncMutex.lock` at 123-134).
2. The `return` leaves the block. `await using` calls `close()` → `runtime.close()` (`sql-runtime.ts:902-904`) → `PostgresUnboundDriverImpl.close()` sets `#delegate = null` synchronously (`packages/3-targets/7-drivers/postgres/src/exports/runtime.ts:133`) → `PostgresDirectDriverImpl.close()` waits for the lease (`postgres-driver.ts:745`).
3. The transaction wins the lease, sends `BEGIN`, and runs `fn`. The first query inside `fn` goes `txCtx.query` → `queryAgainstQueryable(plan, driverTx)` → `streamRows` → `setupDriverExecution` (`sql-runtime.ts:371-378`) → `verifyMarker()` → `readMarker(this.driver)` (`sql-runtime.ts:914`). The marker read uses the runtime's driver, not the transaction's connection. The wrapper's delegate is `null` → `DRIVER.NOT_CONNECTED` → wrapped as `CONTRACT.MARKER_READ_FAILED`.
4. `fn` rejects; `withTransaction` rolls back on the still-open client, releases the lease (`sql-runtime.ts:1097-1101`) and rethrows. The `db.transaction()` promise is now rejected with no handler.
5. Only now can `PostgresDirectDriverImpl.close()` continue to `pg.Client.end()` (`postgres-driver.ts:758`), which resolves when the socket closes: an I/O event. Node empties the microtask queue, finds the rejected promise without a handler, and emits `unhandledRejection`.
6. The socket closes, disposal finishes, the async function resolves its own promise with the rejected inner promise, and a handler is attached: `PromiseRejectionHandledWarning`.

With `verifyMarker: false` or after an awaited query, step 3 never touches the driver-level path: the transaction's queries run on the held lease, the transaction commits, and `close()` runs afterwards. The same mistake therefore succeeds or fails depending on whether it is the first query on the connection.

`orm.all()` and `runtime().query()` return an `AsyncIterableResult`, a thenable whose work starts in `then()` → `toArray()` (`packages/1-framework/1-core/framework-components/src/execution/async-iterable-result.ts:53-60, 80-85`). Their `then` runs after disposal, so the rejection lands on a promise the caller already observes: an error, but no unhandled rejection. `orm.first()` wraps the same thenable in an eager async function, which is why `first()` behaves like `transaction()` and `all()` does not.

`db.prepare()` resolves: `SqlRuntimeBase.prepare` lowers the plan and never calls the driver (`sql-runtime.ts:564-621`). The mistake is invisible until the statement is run.

## Q2. Why does the error say "not connected. Call connect(binding)" after a close?

The driver does record the close: `PostgresUnboundDriverImpl.close()` sets `#delegate = null` and `#closed = true` (`exports/runtime.ts:130-137`), and the `state` getter returns `'closed'` (`54-62`). But the error paths never read `#closed`: `#requireDelegate()` (`64-70`), `query()` (`139-142`), `execute()` (`144-150`) and `explain()` (`152-159`) branch only on `#delegate === null` and all use `USE_BEFORE_CONNECT_MESSAGE` (`23-24`). The direct driver has a better message, "Postgres connection lost or closed. Create a new client to reconnect." (`postgres-driver.ts:762-767`), but it is unreachable after `close()` because the wrapper drops the delegate first.

The extension already has the right error, `closedConnectionError()` in `postgres-serverless.ts:81-87` ("Postgres connection is closed", why: "close() was called on this connection, or the await using scope that held it has ended."). It is only thrown by `getRuntime()`, which the ORM shim and the members call when the query is built (`postgres-members.ts:72-82, 94, 107`), not when it runs. The pooled client's "Postgres client is closed" (`postgres.ts:191-198`) has the same limitation.

## Q3. Why is the driver error wrapped as `CONTRACT.MARKER_READ_FAILED`?

`verifyMarker()` calls the adapter's `readMarker` (`packages/3-targets/6-adapters/postgres/src/core/adapter.ts:58-70`) → `readMarkerDiscriminated` → `withMarkerReadErrorHandling` (`packages/1-framework/1-core/errors/src/execution.ts:190-199`) → `rethrowMarkerReadError` (`159-188`). That function passes through `CliStructuredError`s, maps parse errors and the legacy table shape, and wraps every other error as `errorMarkerReadFailed` (`99-115`), whose `fix` is "Verify read permissions, connectivity, and locks, then retry." The driver's error is a plain `Error` with `code`, `category: 'DRIVER'`, `severity` (`packages/3-targets/7-drivers/postgres/src/driver-error.ts`), not a `CliStructuredError`, so it is wrapped.

Should a driver error that means "no connection" pass through unwrapped? Yes. `MARKER_READ_FAILED` describes a problem with the marker table (permissions, locks, connectivity to it). A `DRIVER`-category error describes the transport and already carries a code and, after the fix below, a `fix`. Wrapping it replaces a correct diagnosis with a wrong one. The rule that costs least: `rethrowMarkerReadError` rethrows any error whose `category` is `'DRIVER'` unchanged. The existing tests feed plain `Error('permission denied …')` objects (`packages/1-framework/1-core/errors/test/execution.test.ts:201-219`, `packages/3-targets/6-adapters/postgres/test/control-adapter.test.ts:1991-2011`) and keep passing. With the runtime fix in place, a closed runtime never reaches the marker read, so this rule matters for the remaining transport failures (socket lost mid-session, a driver used before `connect`).

## Q4. The smallest fix

Two rules, both owned by the runtime, since every path (ORM, `sql`, prepared statements, transactions, pooled and serverless clients) runs through `SqlRuntimeBase`:

1. An operation that reaches the runtime after `close()` has started fails with one structured error that says the runtime is closed, before any driver call.
2. A promise the runtime or `withTransaction` hands out does not reject before `close()` has settled, so the rejection cannot precede the caller's handler.

### `@internal/sql-runtime` (`packages/2-sql/5-runtime/src/sql-runtime.ts`)

- `close()` memoises `this.closePromise = this.driver.close()` and exposes it as `get closing(): Promise<void> | null`. `ConnectionProvider` (line 972) gets the same optional getter so `withTransaction` can read it; the supabase provider does not have it and is unchanged.
- `closedError()`: `structuredError('DRIVER.NOT_CONNECTED', 'Runtime is closed', { why: 'close() ran on this runtime before the operation reached the database.', fix: 'Await every query, transaction and prepared statement before the runtime closes. A query returned without `await` from an `await using` scope, or started after close(), runs after the connection has closed.' })` from `@internal/utils/structured-error` (the package already depends on `@internal/utils`). Keeping the code `DRIVER.NOT_CONNECTED` keeps existing handlers, tests and the error reference's "or after it was closed" wording valid; the extension's `closedConnectionError` and "Postgres client is closed" already use it. A new `RUNTIME.CLOSED` code would give handlers two codes for one situation.
- `setupDriverExecution(exec)` gains the scope (it is called from `streamRows` at 391, `executeStatisticsAgainstQueryable` at 547 and `runPreparedExecuteAgainstQueryable` at 736; the scope is already in `middlewareCtx.scope`). Before the marker read: if `closing !== null`, then for scope `'runtime'` `await closing.catch(() => undefined)` and throw `closedError()`; for scope `'connection'` or `'transaction'` throw at once. Waiting inside a held lease would deadlock: `PostgresDirectDriverImpl.close()` waits for that lease, and the lease holder waits for the operation.
- `connection()` (765) gets the same check with the runtime-scope wait, so `db.runtime().connection()` after close fails cleanly.
- `withTransaction` (976): wrap the existing body so that, after its `finally` has released the connection, a rejection waits for `runtime.closing` before it is rethrown. The order matters: release first, then wait, or `close()` never gets the lease. This makes `return db.transaction(fn)` fail with the closed error in every variant (first query or not, `verifyMarker` on or off), instead of committing by accident in two of them.
- `verifyMarkerPromise` (176-177, 374-377): reset it to `null` when `verifyMarker()` rejects, so the next query retries the read instead of repeating the old failure (see Q5.1).

Why not "wait for in-flight work, then close" (the ticket's option 3)? It would make `return db.transaction(fn)`, `first()` and `execute()` succeed and `all()` still fail, so the same mistake would keep two outcomes. It also needs the runtime to count in-flight streams, and an abandoned stream (started, never finished, no `return()`) would make `close()` wait for ever. The chosen design fails the same way in every variant and never blocks `close()` on user code that has not already blocked it today.

### `@internal/postgres` (`packages/3-extensions/postgres/src/runtime/`)

- `postgres.ts` `close()` (287-292): when the client owns the pool (`binding.kind === 'url'`), close through `runtimeInstance.close()` instead of `pool.end()` directly, so the runtime's closed check applies and pg-pool's uncoded error cannot surface. `ownedDispose` stays for the connect-failure path (182-186) and for a client whose runtime was never created. A user-supplied pool or client is not ended today and stays that way.
- `postgres-serverless.ts`: no code change. `closing ??= runtime.close()` (166-170) already exists; `getRuntime()`'s synchronous `closedConnectionError` (171-176) stays for `runtime()`, `transaction()` and `prepare()` called after close.
- Docs that today describe the wrong error as expected behaviour and must change with the fix: `packages/3-extensions/postgres/README.md:66`, `docs/Serverless Deployment Guide.md:36`, `docs/reference/error-reference.md:456` (`CONTRACT.MARKER_READ_FAILED`) and `:1193` (`DRIVER.NOT_CONNECTED`).

### `@internal/driver-postgres` (`packages/3-targets/7-drivers/postgres/src/exports/runtime.ts`), recommended

- In `#requireDelegate`, `query`, `execute` and `explain`, use a second message when `#closed` is true: "Postgres driver is closed. Call connect(binding) to reconnect." Same code. Not needed for the three properties (the runtime no longer reaches a closed driver), but anyone who uses the driver directly still gets the wrong sentence today.

### `@internal/errors` (`packages/1-framework/1-core/errors/src/execution.ts`), recommended

- `rethrowMarkerReadError`: rethrow errors with `category === 'DRIVER'` unchanged (Q3).

### Tests that fail before the fix

- `packages/3-extensions/postgres/test/postgres-serverless.test.ts`, new `describe('a promise returned from an await using scope without await')`. Use the default `verifyMarker` (the fixture helper sets `verifyMarker: false`, which would skip the marker path) and set `recorded.endImpl = () => new Promise((resolve) => setTimeout(resolve, 0))` so the mocked `Client.end` takes a macrotask, like the real socket. Cases: `orm.all()`, `orm.first()`, `runtime().query(plan)`, `runtime().execute(plan)`, `transaction(fn)`, each with and without an awaited query first. Assert `rejects.toMatchObject({ code: 'DRIVER.NOT_CONNECTED', message: 'Runtime is closed', fix: expect.stringContaining('await using') })` and that `pg.Client.query` was not called after `end`. Before the fix these fail twice: the error is `CONTRACT.MARKER_READ_FAILED` (or the "Call connect(binding)" message), and vitest fails the run on the unhandled rejection from `first()`, `execute()` and `transaction()`.
- `packages/3-extensions/postgres/test/postgres.test.ts` (pooled): a query built before `close()` and awaited after rejects with the same closed error, `Pool.end` is called once, and a user-supplied pool is not ended.
- `packages/2-sql/5-runtime/test/runtime-closed.test.ts` with `createTestRuntime` and a stub driver whose `close()` resolves on a macrotask and waits for released connections: `execute()` started before `close()` settles after `close()` (record settle order with `finally`); `execute()`, `query().toArray()` and `connection()` after `close()` reject with the closed error and make no driver call; a connection-scoped query throws at once while the connection is held and `close()` completes after `release()`; `withTransaction` rejects only after `closing` settles; a rejected marker read is retried by the next query.
- `packages/3-targets/7-drivers/postgres/test/driver.unbound.test.ts`: after `close()`, `acquireConnection`, `query`, `execute` and `explain` reject with the closed message.
- `packages/1-framework/1-core/errors/test/execution.test.ts`: `rethrowMarkerReadError` rethrows a `driverError('DRIVER.NOT_CONNECTED', …)` unchanged.

## Q5. Other findings

1. One failed marker read poisons the runtime for good. `setupDriverExecution` stores the first `verifyMarker()` promise and never resets it (`sql-runtime.ts:374-377`). Probe `poison.ts`: one simulated transient driver failure, three failing reads. For a long-lived pooled client, a database that is unreachable at the first query leaves the client failing until the process restarts.
2. `postgres().close()` ends the pool but leaves the runtime and driver "connected" (`postgres.ts:287-292`). Work that reaches the driver afterwards fails inside pg-pool with `Error: Cannot use a pool after calling end on the pool`, which `normalizePgError` (`packages/3-targets/7-drivers/postgres/src/normalize-error.ts`) does not classify, so it has no error code.
3. The transaction variant of the mistake commits when it is not the first query on the connection (probe rows `tx noverify`, `tx warm`). The lease taken by `withTransaction` blocks `close()` until commit, so the user's code appears to work in tests with a warm connection and fails in production on a fresh one.
4. `orm.first()` is eager (a promise) while `orm.all()` is lazy (a thenable). That is why `first()` produces an unhandled rejection and `all()` does not. The fix covers both; making `first()` lazy as well would be a separate, optional consistency change.
5. Marker verification always runs on the runtime's driver (`sql-runtime.ts:914`), even for a query inside a transaction that holds the connection. On the direct driver it goes through the same socket, so it works, but it is the reason the transaction case fails on the driver-level state while the transaction itself is alive.
6. The docs (README:66, Serverless Deployment Guide:36, error-reference:456) currently teach `CONTRACT.MARKER_READ_FAILED` with cause `DRIVER.NOT_CONNECTED` as the expected error for this mistake. They must be rewritten with the fix.
7. A `RuntimeConnection` from `db.runtime().connection()` that is never released blocks `close()` for ever on the direct driver (`postgres-driver.ts:745`). Pre-existing, unchanged by the fix; worth its own note in the docs.

## Environment notes

`/usr/bin/git` is blocked by the Xcode licence prompt; every command used `/opt/homebrew/bin/git` (2.53.0) by putting `/opt/homebrew/bin` first in `PATH`. The shell's `pnpm` was missing for Node 26.8.1; the corepack shim in `~/.nodenv/versions/24.13.0/bin` runs pnpm 10.27.0 (the version in `packageManager`) under the homebrew Node 26.8.1, so no version switcher was used. `wip/spike-2419/node_modules` is a symlink to the example's `node_modules` so the probes resolve `@prisma/orm-postgres` and `pg`. `git status --short` is empty.
