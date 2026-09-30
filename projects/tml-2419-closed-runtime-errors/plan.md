# Dispatch plan

Two dispatches, one implementer. Validation gate for both: `pnpm typecheck`, `pnpm test` and `pnpm lint` in each changed package, then `pnpm lint:deps` and `pnpm check:upgrade-coverage --mode pr --prev origin/main --head HEAD` at the root. Save every run's output to a file under `wip/` and read the file.

## D1: the runtime rule and its substrate

Outcome: `SqlRuntimeBase.close()` waits for runtime-scope work that started before it and refuses work that starts after it; a held connection keeps working through its own queryable; the driver and the marker-read wrapper report the right error. Spec items 1 to 6, 8 and 9.

Builds on: the branch as it stands (the first implementation). Hands to: D2 the runtime, driver and errors packages green, with `Runtime.closing` and `ConnectionProvider.closing` gone and `withTransaction` back to a plain run.

Focus: tests first, in `packages/2-sql/5-runtime/test/runtime-closed.test.ts` (rewritten), the driver's `driver.unbound.test.ts` and `driver.idle-errors.test.ts`, and the errors package's `execution.test.ts`. Prove each fix with a mutation.

## D2: owners and documents

Outcome: `postgres().close()` closes the runtime it owns and returns one promise; the serverless closed test states the outcome of each unawaited return; the documents describe the rule. Spec items 7 and 10, and the upgrade fragments.

Builds on: D1. Hands to: the slice done, ready for `/drive-code-review`.

Focus: `postgres-serverless.closed.test.ts` and `postgres-close.test.ts` rewritten to the new outcomes, including the two-connection case and the caller's-pool case; then the seven documents and the skill rows.
