---
changes:
  - id: ts-enum-member-written-as-stored
    summary: |
      `defineContract` from the Postgres and SQLite packages now refuses an `enumType` member that the column's codec stores as a different value, with `CONTRACT.ENUM_INVALID`. A uuid member written with an upper-case hex digit or in braces is refused, because `pg/uuid@1` stores lower-case 8-4-4-4-12 text. Write each refused member as the error message says, re-emit, and apply a migration that replaces the enum's CHECK constraint.
    detection:
      glob: "**/*.{ts,mts,cts}"
      matches:
        - '\benumType\('
  - id: psl-uuid-enum-members-emit-lower-case
    summary: |
      A PSL `enum` with `@@type("pg/uuid@1")` whose members are written with an upper-case hex digit or in braces now emits each member as the lower-case text Postgres stores, in `contract.json` and in `contract.d.ts`. The enum's value type, the storage hash and the name of the enum's CHECK constraint change. Update code that uses the old spelling, re-emit, and apply a migration that replaces the CHECK constraint.
    detection:
      glob: "**/*.prisma"
      matches:
        - '@@type\(\s*"pg/uuid@1"\s*\)'
  - id: uuid-default-emits-lower-case
    summary: |
      A literal default on a uuid column written with an upper-case hex digit or in braces, in PSL or with `.default()` in TypeScript, is now stored in `contract.json` as the lower-case text Postgres stores, so `db init` and `db verify` no longer report that column's default as a mismatch. Re-emit the contract; its storage hash changes.
    detection:
      glob: "**/*.{prisma,ts,mts,cts}"
      matches:
        - '[.@]default\(\s*\[?\s*[\x27"\x60](?=[0-9a-f-]*[A-F])[0-9A-Fa-f]{8}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{12}[\x27"\x60]'
        - '[.@]default\(\s*\[?\s*[\x27"\x60]\{[0-9A-Fa-f-]{32,39}\}[\x27"\x60]'
---

## `ts-enum-member-written-as-stored`

The types of a TypeScript contract name each `enumType` member as written, in `db.enums` and in the types of the fields that use the enum, while `contract.json` and the database hold what the column's codec stores. The two now have to be the same value, so `defineContract` refuses a member its codec stores as something else and says what to write:

```text
CONTRACT.ENUM_INVALID: enumType("Key"): member "A" is written "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11", but the column stores "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11". Write the member as "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11".
```

Refused members:

- On a uuid column (`pg/uuid@1`), a member with an upper-case hex digit, in braces, or without hyphens. Write it in lower case, hyphenated 8-4-4-4-12.
- A member that got past the type check with a value of the wrong type, for example through a cast. The number `1` on `pg/int8@1` is refused with "Write the member as 1n". The number `1.5` on `pg/numeric@1` is refused because the codec cannot read the stored number back; write `'1.5'`.

1. Run `prisma contract emit`, or run the code that calls `defineContract`. Each refused member is reported with the value to write. To find uuid members first, search the calls to `member(` in your contract for a uuid with an upper-case hex digit or a brace.
2. Rewrite each refused member as the message says. Code that reads members through the enum, such as `Key.members.A` or `db.enums.public.Key.members.A`, needs no change. Code that compares a value with the old spelling does: values read from the database were always in the stored form.
3. Re-emit. If a column uses the enum, its membership CHECK constraint's expression changes, and a CHECK constraint's name is derived from its expression, so the storage hash and the constraint's name both change. Plan and apply a migration: it drops the old CHECK constraint and adds the new one. Dropping a constraint is a destructive operation, so the plan needs the destructive operation class allowed.

## `psl-uuid-enum-members-emit-lower-case`

An enum such as this one used to emit its members as written:

```prisma
enum Key {
  @@type("pg/uuid@1")
  A = "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11"
  B = "{B0EEBC99-9C0B4EF8-BB6D6BB9-BD380A11}"
}
```

It now emits `a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11` and `b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11`, in `contract.json` and in the value types in `contract.d.ts`. An enum whose members are already lower case, hyphenated 8-4-4-4-12, emits what it did before.

1. Re-emit the contract.
2. Type-check. Code that compares a value with the upper-case or braced spelling no longer type-checks against the enum's value type; compare with the lower-case text or with `db.enums.public.Key.members.A`. You may also rewrite the members in the schema in lower case, so the schema shows what is stored; the contract is the same either way.
3. Plan and apply a migration. The membership CHECK constraint of each column that uses the enum gets a new name, so the plan drops the old constraint and adds the new one. Dropping a constraint is a destructive operation, so the plan needs the destructive operation class allowed.

## `uuid-default-emits-lower-case`

A default such as `u Uuid @default("A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11")` in PSL, or `.default('A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11')` on a uuid column in TypeScript, used to be stored as written. Postgres stores the default in lower case, so `db init` failed with `MIGRATION.RUNNER_FAILED` and `db verify` reported the column's default as a mismatch. The contract now stores `a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11`, and both commands pass.

Re-emit the contract. Its storage hash changes. A default written with the `sql` tag, such as `` @default(sql`'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'::uuid`) ``, is stored as written, as before, and now passes `db init` and `db verify` too.
