# Slice spec: a query run after its connection or client is closed fails once, clearly, and never as an unhandled rejection

Orphan slice (Linear TML-2419). One pull request. Branch `tml-2419-closed-runtime-errors`, based on `tml-2398-serverless-client-symmetry` (prisma/orm#30482, approved, not yet merged). The root-cause research is in `wip/findings.md` (copied from the spike); read it first.

## At a glance

```ts
async function listUsers(url: string) {
  await using db = await postgres.connect({ url });
  return db.orm.public.User.all(); // missing await
}
```

Today this fails with "Database error while reading contract marker", caused by "Postgres driver not connected. Call connect(binding) …". The same mistake with `return db.transaction(...)` also raises an unhandled promise rejection, which ends a Node.js process by default; under some conditions it commits instead. After this slice, every such call rejects with one `DRIVER.NOT_CONNECTED` error that says the runtime is closed and names the likely cause, the rejection reaches only the caller, and the outcome does not depend on timing.

## Chosen design

1. **`@internal/sql-runtime` owns the rule.** `SqlRuntimeBase.close()` records a single closing promise. Every operation that would reach the driver after close has started (query, execute, connection, marker read) fails with one structured `DRIVER.NOT_CONNECTED` error: message "Runtime is closed"; `why` says `close()` was called, or the `await using` scope that held it ended; `fix` names the two likely causes, a query returned without `await` inside an `await using` scope, and use after `close()`.
2. **The rejection is delivered after the close settles.** Runtime-level operations wait for the closing promise before they reject, so the caller has attached its handler and Node never reports an unhandled rejection. Operations on a connection or transaction that already holds a lease reject at once, because waiting inside a held lease would deadlock. `withTransaction` rejects only after it has released its connection and the close has settled.
3. **One outcome for one mistake.** An unawaited `return db.transaction(fn)` fails the same way whether or not the marker was verified before.
4. **A failed marker read does not poison the runtime.** The cached marker check is cleared when it rejects, so a later call retries.
5. **`postgres().close()` closes the runtime** when the client owns the pool, so a client and a connection fail the same way after close. A pool or `pg.Client` the caller passed in is not ended.
6. **Driver and errors.** After `close()`, the Postgres driver's error says it is closed, not "not connected. Call connect(binding)". `rethrowMarkerReadError` passes `DRIVER`-category errors through without wrapping them as `CONTRACT.MARKER_READ_FAILED`.
7. **Documents.** The Postgres README, the deployment guide, ADR 207, the skill references and the error reference currently describe the old errors for this mistake; they describe the new one.

Correct code does not change behaviour.

## Scope

In: `packages/2-sql/5-runtime` (sql-runtime), `packages/3-extensions/postgres`, the Postgres runtime driver in `packages/3-targets/7-drivers/postgres` (closed message only), the marker-read wrapper in the errors package, their tests, the documents above, upgrade instructions as `check:upgrade-coverage` requires.

Out: waiting for in-flight work before closing (rejected: one mistake would have two outcomes depending on timing, and an abandoned stream could block `close()` for ever); detecting a query through `db` inside its own transaction (TML-3344); `transaction()` and `prepare()` throwing synchronously on a closed client (TML-3345); a leaked `runtime().connection()` blocking `close()` on the direct driver (record as a ticket if confirmed); SQLite and Mongo clients (check them and record tickets if they share the bug).

## Done when

- Each symptom in `wip/findings.md` has a test that fails before the fix, including a test run that fails on any unhandled rejection.
- Measured against Docker Postgres in Node and in workerd: the unawaited `all()`, `first()`, `runtime().query()`, `runtime().execute()` and `transaction()` each reject once with the new error; no unhandled rejection; the process keeps running.
- `/drive-code-review` (no walkthrough) run and its findings fixed; manual QA done.
