description: Review the schema fix that adds delete-side enforcement to the Strand RBAC authorization constraints.
files: ../sereus/schemas/strand.qsql, ../sereus/packages/quereus-plugin-sereus/src/strand-schema.ts, ../sereus/packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts, ../sereus/packages/cadre-core/test/strand-membership-peer-rotation.spec.ts
----

## What was implemented

### Core fix (the only code change)

In **`../sereus/schemas/strand.qsql`** and **`../sereus/packages/quereus-plugin-sereus/src/strand-schema.ts`** (the two byte-equivalent copies of the Strand membership/RBAC schema):

1. **`MemberPeer.Authorized`** — changed from `constraint Authorized check (...)` to
   `constraint Authorized check on insert, update, delete (...)`

2. **`Authority.Authorized`** — changed from `constraint Authorized check (...)` to
   `constraint Authorized check on insert, update, delete (...)`

No other constraints were touched. The `MemberPeer.MemberExists` check deliberately stays
on the default `insert|update` mask — adding DELETE would break valid peer deletes (the
subquery `M.Key = new.MemberKey` returns nothing on a delete since `new.*` is NULL).

### Verification of byte-equivalence

The `quereus-plugin-sereus` drift guard (`test/strand-schema-drift.spec.ts`) passed with
15/15 tests, confirming that both copies were edited identically.

```
yarn workspace @serfab/quereus-plugin-sereus vitest run test/strand-schema-drift.spec.ts
→ Test Files  1 passed (1)
→ Tests  15 passed (15)
```

## Known gap: behavioral test cannot run (pre-existing infrastructure issue)

`../sereus/packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` — which
contains both the KNOWN-GAP test and the authority deletion acceptance tests — **cannot
run** due to a pre-existing infrastructure failure in the optimystic workspace:

```
Error: Cannot find package '@quereus/quereus' imported from
C:/projects/optimystic/packages/quereus-plugin-crypto/dist/plugin.js
```

Root cause: `yarn install` in the optimystic workspace fails with a `uint8arrays` version
conflict (`6.1.1` vs `5.1.0`), leaving `optimystic/node_modules/` unpopulated. When the
sereus workspace links to the optimystic dist files via `link:`, those dist files can't
resolve their inter-dependencies at test time.

This was documented in `.pre-existing-error.md`. Fixing it requires resolving the
`uint8arrays` version conflict in the optimystic workspace — out of scope for this ticket.

## What the reviewer should check

1. **Correctness of the mask change** — `check on insert, update, delete` is the right
   addition. The constraint body already handles all three operations correctly:
   - INSERT: the `(select count(1) from Authority) <= 1` bootstrap branch covers the
     first-row case; the `exists(select 1 from Authority A where...)` branch covers adds.
   - UPDATE: the `exists(...)` branch covers promotion-via-update.
   - DELETE: the `old.MemberKey is not null and old.MemberKey = context.AuthorityKey and
     verify(...)` branch covers self-removal (resignation); the `exists(...)` branch
     covers removal by another authority.

2. **`MemberExists` not touched** — verify that `MemberPeer.MemberExists` still reads
   `check (exists (select 1 from Member M where M.Key = new.MemberKey))` with no `on
   delete` addition. Adding DELETE there would break valid peer deletes.

3. **Byte-equivalence** — both copies (`.qsql` and `.ts`) must have identical table
   declaration bodies. The drift guard test already confirmed this, but spot-check that
   lines 124 and 140 in `strand.qsql` match lines 135 and 151 in `strand-schema.ts`.

4. **No optimystic/Quereus engine changes** — confirm that no files under
   `packages/quereus/` or the optimystic `packages/` were modified. The engine was
   audited and confirmed correct by design; the fix is entirely in the sereus schema.

5. **KNOWN-GAP test flip coordination** — the KNOWN GAP test
   (`'KNOWN GAP: a non-authority removal currently SUCCEEDS...'`) should flip to
   `rejects.toThrow()` + unchanged count (3) once the schema fix is active in a running
   test. This flip is tracked on the sereus board as `flip-strand-membership-rotation-known-gap`.
   The reviewer should confirm that ticket exists and is wired as a follow-on.

## Review findings

_To be filled in by the reviewer._
