---
changes:
  - id: postgres-set-default-takes-a-typed-default
    summary: |
      In a Postgres `migration.ts`, `this.setDefault(...)` takes the default as `lit(...)` or `fn(...)`, with the column `type` and `codecRef`, in place of `defaultSql`.
    detection:
      glob: "**/migration.ts"
      matches:
        - '(?<![\w$])defaultSql\s*:'
---

# `setDefault` in a Postgres migration takes the default, not its SQL

`this.setDefault(...)` no longer takes the SQL of the `DEFAULT` clause. It takes the default the way `col(...)` takes it for `this.addColumn(...)`: `lit(value)` for a literal, `fn(expression)` for an expression. It also takes the column type and, for a literal, the column codec. The adapter writes a literal through that codec, so a `Bytes` default stores the bytes its base64 text encodes, as it does in `CREATE TABLE`.

Rewrite each call:

```diff
  this.setDefault({
    schema: 'public',
    table: 'user',
    column: 'status',
-   defaultSql: "DEFAULT 'open'",
+   type: 'text',
+   default: lit('open'),
+   codecRef: { codecId: 'pg/text@1' },
  })
```

```diff
  this.setDefault({
    schema: 'public',
    table: 'user',
    column: 'createdAt',
-   defaultSql: 'DEFAULT (now())',
+   type: 'timestamptz',
+   default: fn('now()'),
  })
```

- `type` is the column type as `col(...)` takes it, with `[]` for a list, as in `'bytea[]'`.
- `default` is `lit(...)` holding the value `contract.json` stores for the column default, or `fn(...)` holding the expression inside the parentheses of `DEFAULT (...)`.
- `codecRef` is the column codec: its `codecId` from `contract.json`, with the column's `typeParams`, and `many: true` for a list. Without `codecRef` a literal is written as given.

Add `lit` or `fn` to the import from `@internal/postgres/migration` beside `Migration`.

An applied migration is unaffected: applying a migration reads `ops.json` and never loads `migration.ts`. The edit is needed only before running a `migration.ts` again.
