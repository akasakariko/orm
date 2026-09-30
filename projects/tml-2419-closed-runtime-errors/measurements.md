# Measurements after the fix

Docker Postgres 16 from `examples/prisma-8-cloudflare-worker` (port 5433, `pnpm db:init && pnpm seed`), built `dist/` of every package at the fix commits. Full outputs: `wip/measure/node-output.txt` (Node 26.8.1, `wip/measure/probe.ts`, one process per case) and `wip/measure/workerd-output.txt` (workerd through the example's vitest-pool-workers config and its local Hyperdrive binding, temporary test `examples/prisma-8-cloudflare-worker/test/zz-closed-scope.probe.test.ts`, deleted afterwards).

## Node, serverless connection, `await using` scope, promise returned without `await`

Every case in every variant (first query on the connection, `verifyMarker: false`, after an awaited query) gave the caller one error, `DRIVER.NOT_CONNECTED: Runtime is closed`, with `why` "close() was called on this runtime, or the await using scope that held it has ended." and the `fix` that names the missing `await`. The `unhandledRejection` listener fired 0 times in every case, and every process reached its final line and exited 0.

| Case | Caller gets | Unhandled rejection |
| --- | --- | --- |
| `return await db.orm.public.User.all()` (control) | 2 rows | no |
| `return db.orm.public.User.all()` | Runtime is closed | no |
| `return db.orm.public.User.first()` | Runtime is closed | no |
| `return db.runtime().query(plan)` | Runtime is closed | no |
| `return db.runtime().execute(plan)` | Runtime is closed | no |
| `return db.transaction(async tx => (await tx.orm.public.User.all()).length)` | Runtime is closed (rolled back; before the fix this committed with `verifyMarker: false` and after a warm query) | no |
| `return db.transaction(async tx => tx.execute(update))` | Runtime is closed | no |

With `NO_HANDLER=1` (Node's default, which ends the process with exit code 1 on an unhandled rejection) `orm-first`, `runtime-execute` and `tx` all ran to the end and exited 0. Before the fix `tx` exited 1 this way.

## Node, pooled `postgres()` client, `close()` while a promise is pending

| Case | Caller gets | Unhandled rejection |
| --- | --- | --- |
| `const p = db.orm.public.User.all(); await db.close(); return p` | Runtime is closed | no |
| same, after an awaited query | Runtime is closed | no |
| `const p = db.transaction(...); await db.close(); return p` | Runtime is closed | no |
| same, `verifyMarker: false` | Runtime is closed | no |
| `const p = db.runtime().execute(plan); await db.close(); return p` | Runtime is closed | no |

Before the fix these failed inside pg-pool with the uncoded `Error: Cannot use a pool after calling end on the pool`, and the transaction produced an unhandled rejection.

## Node, marker read that fails once (`marker-retry`)

One driver-level query made to fail: attempt 1 `CONTRACT.MARKER_READ_FAILED`, attempt 2 `2 rows`, attempt 3 `2 rows`. Before the fix all three attempts failed.

## Node, leaked `db.runtime().connection()` (`leaked-connection`)

`return db.runtime().connection()` from an `await using` scope: disposal started and was still running after 3 s (the watchdog ended the process with exit code 3). The connection holds the direct driver's lease and is never released, so `close()` waits for ever. Confirmed, unchanged by the fix, out of scope.

## workerd, serverless connection, promise returned without `await`

10 of 10 cases passed: `db.orm.public.User.limit(10).all()`, `db.orm.public.User.first()`, `db.runtime().query(plan)`, `db.runtime().execute(plan)` and `db.transaction(fn)`, each as the first query and after an awaited query, rejected with `DRIVER.NOT_CONNECTED` "Runtime is closed", and the `unhandledrejection` listener on the worker global saw 0 events. The first run used unbounded reads, which the example's `budgets` middleware rejected with `BUDGET.ROWS_EXCEEDED` before the closed check ran; the reads were given a `limit` and re-run.
