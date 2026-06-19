description: Protected rows (like a strand admin) could be deleted without a valid signature; the fix adds the missing delete-side enforcement to two Strand authorization rules. Reviewed and confirmed correct.
files: ../sereus/schemas/strand.qsql, ../sereus/packages/quereus-plugin-sereus/src/strand-schema.ts, ../sereus/packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts, ../sereus/packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/quereus/src/planner/building/delete.ts
----

## Summary of the landed change

The defect was a **schema-authoring omission in the sereus Strand schema** — not an
optimystic or Quereus engine bug. A bare `check (expr)` defaults to the
`insert|update` op mask and is deliberately filtered out on DELETE, so the two
authorization constraints that were authored to gate deletes never ran on delete.

The fix is a one-token edit to two constraints, mirrored in both byte-equivalent copies
of the schema:

- `../sereus/schemas/strand.qsql`
- `../sereus/packages/quereus-plugin-sereus/src/strand-schema.ts`

```
constraint Authorized check               (...)   →   constraint Authorized check on insert, update, delete (...)
```
applied to `MemberPeer.Authorized` (strand.qsql:124 / strand-schema.ts:135) and
`Authority.Authorized` (strand.qsql:140 / strand-schema.ts:151).

No optimystic / Quereus engine files changed — the optimystic working tree is clean at
HEAD, confirming the implement claim that the engine is correct by design.

## Review findings

### What was checked

1. **Implement diff, read fresh.** The optimystic implement commit (`9bc364d`) moved only
   ticket files; it carries no code. The actual schema edit lives uncommitted in the
   sibling sereus working tree. Reviewed that diff directly: the only substantive change is
   the two `on insert, update, delete` additions described above (plus an unrelated
   trailing-newline removal in `packages/cadre-core/vitest.config.ts` — see below).

2. **Engine ordering / DELETE constraint semantics.** Read
   `quereus/packages/quereus/src/planner/building/delete.ts`. The plan tree is
   `DmlExecutorNode → ConstraintCheckNode(RowOpFlag.DELETE) → DeleteNode → source`, so the
   constraint check (and any subquery it contains) evaluates against the **pre-delete**
   table state — the row being removed is still present at check time. Confirmed the
   delete path already wires `buildConstraintChecks(..., RowOpFlag.DELETE, ...)` with the
   OLD/NEW flat-row expansion; nothing in the engine needed to change.

3. **Constraint-body correctness on DELETE** (with OLD populated, NEW = NULL):
   - `MemberPeer.Authorized` — `verify(digest(coalesce(new,old)...), context.Signature,
     coalesce(new.MemberKey, old.MemberKey), 'ed25519')` resolves to the member's own key
     and payload on delete, so a peer delete requires the member's signature. Correct.
   - `Authority.Authorized` — the self-removal branch
     (`old.MemberKey = context.AuthorityKey and verify(old.MemberKey ...)`) and the
     "another existing authority" branch both function on DELETE. Correct.

4. **Byte-equivalence.** The `.qsql` and `.ts` table bodies match by eye, and the
   `quereus-plugin-sereus` drift guard passes 15/15
   (`vitest run test/strand-schema-drift.spec.ts`).

5. **`MemberExists` correctly left untouched.** It stays on the default `insert|update`
   mask — adding DELETE would make its `new.MemberKey` subquery match nothing and reject
   every valid peer delete.

6. **No optimystic / Quereus engine changes.** `git diff --stat HEAD` is empty.

7. **Follow-on flip ticket exists.** `flip-strand-membership-rotation-known-gap` is present
   in `../sereus/tickets/backlog/` and is correctly gated on this fix landing.

### Findings & disposition

- **(Blocker for runtime verification — already ticketed, NOT re-filed)** The behavioral
  suite `../sereus/packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` still
  cannot exercise the fix. The original `Cannot find package '@quereus/quereus'` install
  failure was fixed by the runner's triage (commit `f5a5497` added a `uint8arrays: ^6.1.1`
  resolution). With the suite now loading, **10/14 tests fail at setup** with
  `Unsupported output encoding: utf8` thrown from `quereus-plugin-crypto`'s `digest`
  (via `signStrandPayload` in `addExtraAuthorities`, before any delete is attempted). This
  is an independent crypto-plugin caller-API regression, **already captured** as
  `tickets/backlog/crypto-digest-variadic-breaks-downstream-callers.md`. The schema fix is
  therefore validated by static analysis + the drift test only; end-to-end behavioral
  confirmation (KNOWN GAP → `rejects.toThrow()`, count stays 3) is blocked on that crypto
  ticket. Not re-filed to avoid duplicate triage.

- **(Minor / residual gap — documented, not fixed)** `Authority.Authorized`'s bootstrap
  branch `(select count(1) from Authority) <= 1` is evaluated pre-delete, so deleting the
  **last** remaining authority is still permitted without a signature. This is a residual
  edge (arguably acceptable — the last authority resigning) and a strict improvement over
  the prior state where *all* authority deletes were unsigned. Left as-is; noted for the
  sereus board if last-authority lockout policy ever matters.

- **(Pre-existing, out of scope — documented)** `Member` has no delete-side authorization
  at all (`Authorized check on insert` + `NoUpdate check on update`), so a `Member` row can
  be deleted unsigned. This is explicitly an acknowledged TODO in the schema
  (`-- TODO: handle member revocation constraint`) and was outside this ticket's
  Authority+MemberPeer scope. The sereus flip ticket already flags re-examining
  `removeMemberPeer` feasibility; member revocation belongs to that same future work, not
  this fix.

- **(Doc nit on the sereus follow-on — for the sereus board)** The
  `flip-strand-membership-rotation-known-gap` ticket's Background still attributes the gap
  to "the optimystic bootstrap-mode transactor does not evaluate deferred CHECK constraints
  on DELETE." The implement research disproved that — the cause was the schema op-mask
  omission, and the engine is correct by design. The flip ticket's narrative should be
  corrected when it is promoted, but it does not block.

- **(Stray, not mine to touch)** The sereus working tree carries an unrelated trailing-
  newline removal in `packages/cadre-core/vitest.config.ts`. It is not part of this fix and
  lives outside the optimystic tree; left untouched per the don't-sanitize-the-working-tree
  rule.

### Empty categories

- **New bugs introduced by the change:** none. The edit is additive (widens the op mask of
  two already-correct constraint bodies) and cannot regress insert/update behavior.
- **DRY / modularity / type-safety concerns:** none — the change is a two-token schema edit
  kept identical across both required copies, with the drift guard enforcing that invariant.

## Tests run

- `yarn workspace @serfab/quereus-plugin-sereus vitest run test/strand-schema-drift.spec.ts`
  → 15/15 pass (byte-equivalence of the two schema copies).
- `cd ../sereus/packages/cadre-core && yarn vitest run test/strand-membership-peer-rotation.spec.ts`
  → 10 fail / 4 pass, all 10 from the pre-existing `Unsupported output encoding: utf8`
  crypto regression (ticket `crypto-digest-variadic-breaks-downstream-callers`), none from
  the schema fix.

## Outcome

The schema fix is **correct and minimal**. Approved. End-to-end behavioral proof is
deferred to the already-tracked crypto ticket and the sereus
`flip-strand-membership-rotation-known-gap` follow-on.
