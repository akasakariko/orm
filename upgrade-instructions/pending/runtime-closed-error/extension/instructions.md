---
changes:
  - id: sql-runtime-close-refusal-option
    summary: "The options of SqlRuntimeBase and its subclasses (RuntimeOptions, for example new PostgresRuntimeImpl({ ... })) have a new required key closeRefusal: 'when-idle' | 'at-once' | undefined. Pass 'at-once' for a runtime that many callers share and 'when-idle' for a runtime that one request owns; undefined means 'when-idle'."
    detection:
      glob: "**/*.{ts,mts,cts,tsx}"
      matches:
        - 'new \w*RuntimeImpl\('
        - 'RuntimeOptions'
---

## `sql-runtime-close-refusal-option`

`close()` on a SQL runtime waits for the work already in flight and refuses runtime-scope work that starts later with `DRIVER.NOT_CONNECTED` ("Runtime is closed"). The new `closeRefusal` option says when the refusal begins: `'at-once'` refuses from the call of `close()`, and `'when-idle'` refuses once the runtime has been idle for one turn of the event loop, so work that keeps it busy from the close onward is admitted.

In each place that constructs a runtime class that extends `SqlRuntimeBase`, or builds a `RuntimeOptions` object for one, add the key:

1. If the runtime belongs to a client or service that many callers share, such as a pooled client, pass `closeRefusal: 'at-once'`.
2. If the runtime belongs to one request or one scope, such as a per-request connection, pass `closeRefusal: 'when-idle'`.
3. In a test double, `closeRefusal: undefined` keeps the default, `'when-idle'`.
