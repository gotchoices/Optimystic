description: A cleanup batch for the SQL integration and reference-peer app — including a real bug where the reference peer's offline command opens a second, separate copy of storage so data it writes is invisible to the running node.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/reference-peer/src/cli.ts
difficulty: medium
----

## Items

Assorted low-severity findings from the SQL/apps review, grouped. One is an
actual correctness bug (the reference-peer storage split); the rest are
cleanliness.

### 1. Reference-peer offline storage is a separate instance (real bug)

`reference-peer/src/cli.ts:394-396`: a comment claims the `LocalTransactor`
"uses the same storage as the node," but `createStorage()` runs a **second**
time, creating a **separate** storage instance. So data written via the offline
transactor is invisible to the running node (and vice versa). Relatedly,
`listDiaries` lists only the in-process map, not what is actually persisted.
Expected: the offline path shares the node's storage (or the comment and command
are corrected to state, loudly, that it is a separate store — but shared is the
apparent intent).

### 2. Typed accessors instead of `as any` private-member pokes

`optimystic-module.ts:1254-1255, 1920-1921, 387-394`: code mutates
`IndexManager` private state, reaches into table internals, and casts `this.db`,
all via `as any`. Add proper typed accessors / methods on the owning classes so
these cross-boundary reaches are type-checked rather than cast away.

### 3. Triplicated CLI options

`reference-peer/src/cli.ts`: ~20 commander options are copy-pasted across three
commands. Factor them into a shared option set applied to each command.

## Expected behavior / outcome

- Offline reference-peer commands operate on the same persisted storage the node
  uses; `listDiaries` reflects persisted state.
- No `as any` private-member access at the three cited sites.
- CLI option definitions declared once and reused.

## Notes

Item 1 is the only behavioral bug and warrants a regression check (write via
offline path, read via node path, assert visible). Items 2 and 3 are refactors
with no behavior change — keep them from expanding scope. Split item 1 into its
own follow-up if it grows.
