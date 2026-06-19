description: When a row is deleted, the database skips the permission rules that decide whether the delete is allowed, so anyone can delete protected rows (e.g. remove a strand admin) without authorization.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, ../sereus/schemas/strand.qsql, ../sereus/packages/cadre-core/test/strand-membership-peer-rotation.spec.ts
----

## Problem

The optimystic local (bootstrap-mode) virtual-table transactor (the Quereus engine path
over it) evaluates **deferred** (subquery-bearing) `CHECK` constraints only on `INSERT`,
**not on `DELETE`**. A `DELETE` is staged (`OptimysticVirtualTable.update`, `case 'delete'`)
without the engine re-evaluating the table's deferred `CHECK` constraints against the
`old` row, so the delete is silently accepted regardless of what the constraint says.

This was discovered in sereus implementing `3-strand-membership-peer-and-rotation`. `removeAuthority`
deletes a `Strand.Authority` row; `Authority.Authorized` (a deferred CHECK with subqueries)
is supposed to allow the delete **only** via the existing-authority branch (a different
authority signs `coalesce(new.MemberKey, old.MemberKey)`) or the former-authority self
branch (the target signs its own key). At runtime the constraint is never evaluated on the
delete, so **any party can remove any `Authority` row without a valid signature** — the
strand's admin set has no delete-side protection.

Sibling of:
- `optimystic-insert-pk-uniqueness-not-enforced` — an insert that reuses a PK
  silently overwrites instead of rejecting.
- `optimystic-deferred-constraint-rejection-not-rolled-back` (processed in
  `../sereus/tickets/complete`) — a deferred CHECK that *did* throw at commit didn't roll
  the row back. That fix made *rejected* deferred writes atomic; this ticket is about
  deferred CHECKs that are **never evaluated** on delete.

## Reproduction

`../sereus/packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` →
*"KNOWN GAP: a non-authority removal currently SUCCEEDS (deferred CHECK not enforced on
delete)"* pins the current behavior. Directly:

- Bootstrap a closed strand (founder authority), then add two more authorities → 3 total.
- `delete from Strand.Authority with context AuthorityKey = null, Signature = null where MemberKey = <a3>`
- **Result:** resolves and the row is removed (count 3 → 2). With enforcement the post-delete
  count is 2, so the `(select count(1) from Authority) <= 1` bootstrap branch is false and,
  with a null/garbage signature, **no** branch of `Authority.Authorized` matches — it should
  reject.

Insert-side enforcement works (the same file's `addAuthority` rejection cases and the
`strand-schema.e2e` insert-rejection tests pass), confirming the gap is **DELETE-specific**.

A secondary observation worth verifying during the fix: a **non-deferred** CHECK on delete
(`MemberPeer.Authorized`, a bare `verify()` with no subquery) behaved as a silent **no-op**
in the same probe — a bogus-signature `MemberPeer` delete neither threw nor removed the row.
So delete-side CHECK handling may be inconsistent across deferred vs non-deferred constraints;
audit both paths.

## Why it matters / scope

This is a general authorization gap, not specific to `Authority`: **any** table that relies
on a delete-time `CHECK` (signature/role gate) to authorize removals is unprotected in
bootstrap mode. The sereus control layer should be audited too — e.g. `CadreControl` tables
whose deletes are gated by `verify(...)` CHECKs (`AuthorityKey`/`CadrePeer`/`DeviceToken`
removal in `seed-bootstrap.ts`, `FormationInvite` deletion) — those signed deletes are likely
also unenforced at runtime.

## Expected behavior

A `DELETE` must evaluate the table's `CHECK` constraints (both immediate and deferred)
against the `old` row + bound context, exactly as `INSERT` does, and **reject** (throw, with
the deferred-rollback fix keeping it atomic) when no branch is satisfied. After a rejected
delete the row must remain.

## Notes

- The fix lives in this repo (optimystic; sereus consumes it via root `resolutions`) and/or
  the Quereus engine's constraint-evaluation path — follow the cross-repo pattern from
  `optimystic-deferred-constraint-rejection-not-rolled-back` (processed in
  `../sereus/tickets/complete`). Determine whether the omission is in the vtab transactor
  (`packages/quereus-plugin-optimystic`) or in Quereus's `xUpdate` orchestration (where it
  decides which constraints to evaluate per operation).
- Once fixed, the sereus-side KNOWN GAP test in `strand-membership-peer-rotation.spec.ts`
  should be flipped to `rejects.toThrow()` + unchanged count of 3, and `removeMemberPeer`
  feasibility re-examined (currently out of scope, also blocked by `MemberExists` reading the
  null `new.MemberKey` on delete — see `../sereus/schemas/strand.qsql`). That downstream test
  flip is tracked in sereus (`flip-strand-membership-rotation-known-gap`).
