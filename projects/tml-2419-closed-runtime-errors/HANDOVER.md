# Handover: TML-2419, a query after close fails once and clearly

This folder is transient. Delete it before the pull request merges.

## Read first

1. This file.
2. [spec.md](spec.md): the slice spec. Its design item 2 is now in question; see "Open decision" below.
3. [root-cause-findings.md](root-cause-findings.md): root causes, with file and line references.
4. [reviews/system-design-review.md](reviews/system-design-review.md) (findings SD-01 to SD-11) and [reviews/code-review.md](reviews/code-review.md) (findings F-01 to F-11): the `/drive-code-review` of the current branch. Neither has been fixed yet.
5. [measurements.md](measurements.md): the implementer's measurements against Docker Postgres.
6. The previous session's transcript, for full context: `~/.claude/projects/-Users-wmadden-Projects-prisma-orm--claude-worktrees-serverless-postgres-parity-acd3f4/eb0adfe2-993b-461a-80d1-14826a65bafd.jsonl` (JSON Lines; about 6.5 MB, so search it rather than reading it whole). Session name: `jolly-condor-60: Serverless Postgres client parity`.

## The bug

[TML-2419](https://linear.app/prisma-company/issue/TML-2419/serverless-await-using-runtime-return-fn-silently-disposes-runtime-mid):

```ts
async function listUsers(url: string) {
  await using db = await postgres.connect({ url });
  return db.orm.public.User.all(); // missing await
}
```

On `main`, the query runs after the connection has closed. The error is misleading: `CONTRACT.MARKER_READ_FAILED`, caused by "Postgres driver not connected. Call connect(binding) …". For `return db.transaction(...)` Node also reports an unhandled promise rejection, which ends the process with default settings. With `verifyMarker: false`, or after an earlier awaited query, the same unawaited transaction commits instead. `postgres().close()` has the same problems.

## State

- Branch `tml-2419-closed-runtime-errors`, pushed to the `bot` remote. No pull request yet. `main` (which includes prisma/orm#30482, merged) is merged into it.
- Six commits implement the spec as written:
  - `@internal/sql-runtime`: `close()` records a closing promise, and later operations reject with `DRIVER.NOT_CONNECTED` "Runtime is closed" after the close settles.
  - `postgres().close()` closes the runtime it owns.
  - The Postgres driver says "closed" after close.
  - The marker-read wrapper passes `DRIVER` errors through.
  - Documents and a `changes: []` upgrade fragment.
- The main fix works: in Node, every unawaited call rejects once with the new error, and the process keeps running.
- The review found problems that need fixing before a pull request. The biggest:
  - **F-01 / SD-08:** on a pooled `postgres()` client, a transaction running when `close()` is called now rolls back at its next statement; on `main` it commits. This breaks correct code and the documented promise that "`close()` does not abort in-flight queries".
  - **F-02 / SD-11:** refused work waits for `close()` to settle, with no upper bound. If `close()` cannot settle, because a held transaction or cursor is itself waiting on refused work, both hang for ever.
  - **SD-01 / F-08:** the closed check runs after middleware and parameter encoding, not when an operation starts.
  - **F-07 / SD-02:** the fix adds a required `closing` member to the public `Runtime` interface, which breaks outside implementations.
  - **SD-04:** the marker wrapper tests `category`, not the `DRIVER.` code prefix.
  - **F-05 / SD-06:** the driver marks itself closed only when its close finishes.
  - **F-04, F-06, SD-05, SD-09, SD-10:** the documents claim more than the code does.
  - **F-10:** tickets are needed for SQLite, Mongo, Supabase, and a leaked `runtime().connection()` that blocks `close()` for ever.

## Open decision

It was put to Will with a recommendation, and he had not answered when this handover was written.

**Question:** when `close()` is called while work is running, should that work finish, or be cut off?

**Recommended, option 1:** refuse new work at once; let work that already holds a database connection finish; `close()` waits for it. This is how Node's HTTP `server.close()` and `pg`'s `pool.end()` behave, and it keeps `main`'s behaviour and the documented promise. For TML-2419 it means:

- An unawaited `return db.transaction(fn)` has already taken its connection, so it finishes and commits.
- Unawaited reads such as `all()` and `first()` fail with "Runtime is closed".
- There is no unhandled rejection and no hang.

**Option 2:** cut off everything from the moment `close()` starts; running transactions roll back.

Will's last message said nothing against option 1. If he has not answered, build option 1.

**Engineering constraint for option 1.** Refused work must not wait for `close()` to settle, because a held transaction may be waiting on it, which is a deadlock (F-02). So refuse at once. The unhandled-rejection report must still be avoided, because the caller attaches its handler only after `await using` disposal finishes. One way is to mark refused promises as handled where they are created, and on the user-facing promise that `transaction`, `prepare` and `execute` return. Decide and test.

## Next steps

1. Get Will's answer to the open decision, or build option 1.
2. Rewrite `spec.md` design item 2 to match. Brief a Fable implementer with every finding in both reviews. Tests first; prove each fix with a mutation.
3. File the F-10 tickets. Search Linear first; team Terminal.
4. Run `/drive-code-review` again, without the walkthrough. It is required, not optional. Use two new Opus reviewers: system design and code. Fix what it finds.
5. Manual QA against Docker Postgres, in Node and under `wrangler dev` (`examples/prisma-8-cloudflare-worker`), including the probes in `root-cause-findings.md`.
6. Delete this `projects/` folder in a new commit. Open the pull request with the `create-pr` skill:
   - Title form: `TML-2419: <sentence>`, with no `feat(...)` prefix.
   - The description starts with the grounding example and ends with alternatives. Read it once more as a teammate without your context would.
   - Put `Agent: <name>` last in the description.
   - Turn on the CI monitor (`mcp__ccd_pr__set_monitor`, auto-fix).
7. Bring it to Will for final verification.

## Rules that bit the previous session

- **No AI attribution anywhere.** No `Co-Authored-By` line and no "Generated with Claude Code" line. Say so in every subagent brief.
- **Committing.** Use `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"`. New commits only: never amend, rebase, squash, or force-push. Push to the `bot` remote.
- **One name per object.** A **client** is what `postgres()` returns; a **serverless client** is what `postgresServerless()` returns; a **connection** is what `postgres.connect({ url })` returns. Never call a connection a client.
- **Talking to Will.** Do not interrupt him for engineering decisions, and do not end reports with lists of open questions. He sees the design at the start and verifies at the end. Keep replies short.
- **Implementers and reviewers.** Use Fable for implementer subagents and Opus for reviewers.
- **Environment.** After an OS crash, `pnpm` was not on the shell's `PATH`. Prepend `/Users/wmadden/.local/share/mise/installs/node/24.13.0/bin`. A fresh worktree needs `pnpm install`, `pnpm build`, then `pnpm install` again, so that the `prisma` command is linked.
- **Merging `main` after #30482's squash merge.** It gave add/add conflicts, because this branch is based on the pre-squash commits. The trees were identical, so keeping this branch's versions was correct. It is already done.

## Other tickets from this work

[TML-3344](https://linear.app/prisma-company/issue/TML-3344), [TML-3345](https://linear.app/prisma-company/issue/TML-3345), [TML-3356](https://linear.app/prisma-company/issue/TML-3356), [TML-3357](https://linear.app/prisma-company/issue/TML-3357), [TML-3373](https://linear.app/prisma-company/issue/TML-3373), [TML-3374](https://linear.app/prisma-company/issue/TML-3374), [TML-3375](https://linear.app/prisma-company/issue/TML-3375), [TML-3379](https://linear.app/prisma-company/issue/TML-3379).
