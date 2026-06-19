description: A database insert that reuses an existing row's primary key silently overwrites the old row instead of being rejected, which lets single-use records (like one-time invites) be replayed.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, ../sereus/schemas/strand.qsql, ../sereus/packages/cadre-core/test/strand-membership-invite.spec.ts
----

## Problem

The optimystic local (bootstrap-mode) virtual-table transactor does **not** enforce
primary-key uniqueness on `INSERT`. The insert path in
`optimystic-module.ts` (`OptimysticVirtualTable.update`, `case 'insert'`) extracts the
primary key and stages `[[insertKey, [insertKey, encodedRow]]]` into the collection
B-tree. Staging a key that already exists **overwrites** the existing entry — an upsert —
rather than raising a uniqueness/constraint error. Because the operation is classified as
`'insert'` (not `'update'`), any `constraint InsertOnly check on update, delete (false)`
guard also never fires.

This was discovered in sereus while implementing the strand membership invite→join handshake
(`2-strand-membership-invite-join`). The `Strand.ConsumedInvite` table relies on its
primary key (`InviteKey`) to make an invite **single-use**: a second consume of the same
invite should be rejected. Instead, the second insert silently overwrites the existing
`ConsumedInvite` row (re-pointing `InviteKey` at a new `MemberKey`) and admits a second
`Member` — i.e. an invite can be **replayed**.

## Reproduction

`../sereus/packages/cadre-core/test/strand-membership-invite.spec.ts` →
*"KNOWN GAP: a double consume currently overwrites instead of rejecting"* documents the
current behavior:

- consume invite `I` for member `B` → `Member` = {founder, B}, `ConsumedInvite` = {I→B}
- consume the **same** invite `I` for member `C` → **resolves** (should reject)
- result: `ConsumedInvite` = {I→C} (overwritten, still 1 row), `Member` = {founder, B, C}

That test asserts the actual (buggy) behavior so it fails loudly once this gap is closed,
prompting the assertions to flip to the intended `rejects.toThrow()` + unchanged counts.

## Why it matters / scope

This is a general correctness gap, not specific to invites: **any** table that depends on
PK uniqueness for anti-replay / single-use semantics is affected in bootstrap mode. Likely
also relevant to the sereus control layer (`CadreControl.FormationInvite.Token`,
`CadreControl.Strand.Id`, `FormationUsage` PK) — those should be audited as part of the fix.

This is a sibling of the already-fixed
`optimystic-deferred-constraint-rejection-not-rolled-back` (a deferred CHECK that throws at
commit now rolls the row back). That fix made *rejected* deferred writes atomic; this ticket
is about an insert that is *never rejected* in the first place because the duplicate key is
silently accepted.

## Expected behavior

An `INSERT` whose primary key already exists in the collection must be **rejected** (a
constraint/uniqueness violation that throws), matching SQL `INSERT` semantics and the
schema authors' intent. It must NOT silently overwrite the existing row. After such a
rejected insert, the table must be unchanged (the deferred-rollback fix already gives us
atomic rollback once the insert throws).

## Notes

- The fix lives in this repo (optimystic; sereus consumes it via root `resolutions`), so
  landing it follows the same cross-repo pattern documented in
  `optimystic-deferred-constraint-rejection-not-rolled-back` (processed in
  `../sereus/tickets/complete`).
- Consider whether uniqueness should be enforced by the vtab (`update` `case 'insert'`
  checking the collection for an existing key) or surfaced by the Quereus engine before
  `xUpdate`. The vtab owns its storage, so a `collection.get(insertKey)` pre-check in the
  insert branch is the most direct fix.
- Once fixed, the sereus-side KNOWN GAP test in `strand-membership-invite.spec.ts` should be
  flipped to `rejects.toThrow()` + unchanged counts. That downstream test flip is tracked in
  sereus (`flip-strand-membership-invite-known-gap`).
