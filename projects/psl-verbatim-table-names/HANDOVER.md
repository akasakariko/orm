# Handover — psl-verbatim-table-names, written 2026-10-01 by figaro-38

## Read these first

- This session's transcript, for full context: `claude://claude.ai/epitaxy/local_40b9a3cc-13e0-451c-8a29-cec846426779`. An exported copy is at `/Users/wmadden/Downloads/session-export-1790835544047.zip` (9 MB; conversation, subagent transcripts, metadata).
- The project spec, plan and design notes in this directory, and the slice 2 spec at `slices/rename-table-operation/spec.md`.
- The open pull request, https://github.com/prisma/orm/pull/30331, whose description is the current statement of what slice 2 does.

Working notes from this session live in `wip/` in the old worktree, which git ignores, so they do not travel to a fresh worktree. `wip/slice2/progress.md` and `wip/slice2/code-review.md` there hold the round-by-round history and the review findings if you can still reach `/Users/wmadden/Projects/prisma/orm/.claude/worktrees/contract-infer-pascalcase-map-26ad30`.

## What the project does

A PSL model with no `@@map` now names its table, or its Mongo collection, verbatim. It used to lower the first letter, so `model UserProfile` read and wrote `"userProfile"`. That was the only place Prisma 8 transformed identifier case implicitly, nobody on the team knew it existed, and it made `contract infer` produce contracts that `db verify` reported as missing tables.

## State of each slice

| Slice | What it is | PR | State |
|---|---|---|---|
| 1 | Verbatim default in SQL and Mongo PSL, `contract infer` agreement, the `MIGRATION.TABLE_NAME_CASE_CHANGED` planner guard, the `scripts/codemods/add-model-map.mjs` codemod run over every repo schema | [#30317](https://github.com/prisma/orm/pull/30317) | Merged 2026-09-16 |
| 1 | The finished app and extension upgrade instructions, which #30317 merged too early to include | [#30321](https://github.com/prisma/orm/pull/30321) | Merged 2026-09-17 |
| 3 | TypeScript authoring: a cross-space relation never guesses its target table, and a foreign key to a target whose table cannot be read statically is an authoring error | [#30323](https://github.com/prisma/orm/pull/30323) | Merged 2026-09-21 |
| 2 | The `renameTable` migration operation, stated with `this.renameTable({ table, to })` in a hand-written migration | [#30331](https://github.com/prisma/orm/pull/30331) | **Open, this is the work left** |

## Where slice 2 stands

- Branch `psl-verbatim-rename-table`, pushed to the `bot` remote at `0e1cf4d572`. Everything is committed and pushed; the working tree was clean when I wrote this.
- Linear ticket: [TML-3420](https://linear.app/prisma-company/issue/TML-3420/renaming-a-table-loses-its-rows-because-the-planner-can-only-drop-and), In Review, linked to the PR.
- The PR was approved and green on 2026-09-21, queued for merge, and then left the queue without merging. The GitHub timeline records no reason. Main then moved 84 commits ahead and five files conflicted.
- I merged `origin/main` into the branch as commit `21bba77229`, resolved those five conflicts, and a follow-up commit `0e1cf4d572` fixes rename-table test lowerers to render a column default, which main's TML-3278 change now requires.
- The conflicts were in the Postgres planner and its control exports, the SQLite operation-factory call, the SQLite rebuild-postcheck test, and one journey config fixture.

### What is left to do on slice 2

1. **Finish verifying the merge.** An implementer was part way through the checks when this session ended. `build`, `typecheck`, `lint`, `lint:deps`, `lint:casts`, `lint:framework-vocabulary`, `lint:throws` and `check:error-reference` had produced logs; `test:packages` and the rest had not reported. Re-run the whole set on `0e1cf4d572`, one command at a time: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:deps`, `pnpm lint:casts`, `pnpm lint:framework-vocabulary` (it must stay at or below main's count), `pnpm lint:throws`, `pnpm check:error-reference`, `pnpm test:packages`, `pnpm fixtures:check`, `pnpm check:upgrade-coverage --mode pr --prev origin/main --head HEAD`, and only the rename journey files under `test/integration/test/cli-journeys/`.
2. **Check main has not moved again,** and merge it in again if it has.
3. **Put the PR back in the merge queue** and watch it until it actually merges. It silently left the queue once already.
4. **Close out the project** once it merges: move the naming rule into `docs/` (the Data Contract subsystem doc), write an ADR recording the verbatim default, the temporary planner guard and the rename operation, strip references to `projects/psl-verbatim-table-names/**`, and delete this directory. The plan's close-out section lists this.

## What slice 2 contains, so you can review it

- A `renameTable` operation for Postgres and SQLite, with prechecks that the old table exists and the new one does not, and postchecks that the new one exists and the old one is gone.
- `this.renameTable({ table, to })` on the migration facade. It reads the migration's start and end contracts and returns the table rename plus a rename for every object whose name is derived from the table name and that the migration leaves otherwise unchanged: unnamed primary keys, unique constraints and foreign keys, indexes and check constraints. The author spreads the result into `operations`. Postgres also carries row-level security settings and policies to the new name. SQLite drops and recreates indexes, because it cannot rename one.
- `RenameCheckConstraintCall` generalised into `RenameConstraintCall` with a constraint kind, recorded for extension authors in `upgrade-instructions/pending/rename-constraint-call/extension/`.
- Three remedies in the case guard: add `@@map`; with migration history, write the rename migration; with `db update`, run the by-hand statements the target supplies, then `db update` again.
- Two SQLite fixes found by this work: a table rebuild that removed the last unique constraint or foreign key was silently skipped, and `db update` after a by-hand rename created an index before dropping the one whose name collides, which SQLite refuses.

## Decisions that will look odd without context

- **No CLI flag.** An earlier version added `--rename <from>=<to>` to `migration plan` and `migration new`. Will had it removed, because the documented design for stating a rename is a planner hint in the contract source, `@hint(was: ...)`, in the Data Contract and Migration System subsystem docs and ADR 001. The flag was a second, undocumented mechanism. Do not reintroduce it.
- **Only unchanged objects are renamed.** An object the migration also changes keeps the name the database has, so an author writing that change by hand refers to the name they see.
- **The rename must be its own schema change.** `migrate` verifies the database against the migration's end contract, so a rename migration that omits other edits from the same change fails loudly.

## Follow-ups recorded in `plan.md`

- Planner hints, `@hint(was: ...)`, with the four open design questions.
- Extension packages keep migrations directly under `migrations/`, but `migration plan` reads them from `migrations/app/`, so inside an extension package it cannot see the history.

## House rules this work ran into

- Never rewrite history: no rebase, amend, squash or force-push. Bring main in with a merge commit.
- Never add AI attribution lines to commits or PR descriptions. Sign off with `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"`.
- PR titles are `TML-NNNN: sentence`, with no conventional-commit prefix.
- Never run `pnpm test:integration`, `pnpm test:e2e` or `pnpm test:all` in full on this machine. Run the touched files.
- `lint:throws` and `check:upgrade-coverage` only run in CI, so run them locally before pushing.
- Run node, pnpm and commits through `mise exec --`.
- Subagents run on Opus, with `model: "opus"` passed explicitly.
