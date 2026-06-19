description: A database insert that reuses an existing row's primary key used to silently overwrite the old row instead of being rejected; the fix now rejects duplicate-key inserts so single-use records (like one-time invites) can't be replayed.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/db-core/src/collections/tree/tree.ts
difficulty: easy
----

## Status: fix applied and validated during the fix stage

The reproduction, root-cause, and the actual code change are **already in the working
tree** and passing. This implement ticket exists to carry the change forward through the
pipeline: the implement agent should sanity-check the diff, run the suite once more, and
produce the review handoff. The remaining open items are small (see TODO) — none block.

## Root cause (confirmed)

`OptimysticVirtualTable.update` (`case 'insert'`) extracted the primary key and staged
`[[insertKey, [insertKey, encodedRow]]]` straight into the collection B-tree. `Tree.stage`
→ `Collection.act` → `BTree.upsert` — and `upsert` **overwrites** an existing key rather
than failing. Because the op is classified `'insert'` (not `'update'`), an `InsertOnly`
guard never fired either. Net effect: a duplicate-PK insert silently replaced the prior
row (an upsert), which let single-use rows (e.g. `Strand.ConsumedInvite`) be replayed.

## The fix (in `packages/quereus-plugin-optimystic/src/optimystic-module.ts`)

A pre-stage uniqueness check in the insert branch (around `optimystic-module.ts:744`):

```ts
const existing = await this.collection.get(insertKey);
if (existing !== undefined) {
  throw new ConstraintError(
    `UNIQUE constraint failed: ${this.tableName} primary key '${insertKey}'`,
    StatusCode.CONSTRAINT,
  );
}
```

Why this is correct and sufficient for the bootstrap/local transactor this ticket targets:

- **Reads through the same `Tree`/`Collection` instance see both staged and committed rows.**
  `BTree.find` re-reads the root from `collection.tracker` every call (no node cache), so
  `get(insertKey)` observes: (a) rows staged earlier in the *same* transaction — `act`
  applies them to the tracker immediately; and (b) rows committed by *prior* transactions —
  legacy commit (`txn-bridge.ts` `commitTransaction`) calls `tree.sync()`, whose
  `transformCache` folds committed transforms into the read cache; and a fresh session reads
  committed storage lazily through the tracker on open. Verified empirically (debug trace
  showed `get` returning the existing entry in the separate-txn, same-txn, and multi-row
  cases).
- **No `update()` needed.** An earlier hypothesis added `await this.collection.update()`
  before the `get`; the debug trace proved it was unnecessary (the staged/committed row is
  already visible) so it was removed to avoid a per-insert log refresh on the hot path.
- **Atomicity.** The throw happens *before* `markDirtyTrees()`/`stage()`, so this row is
  never staged. Rows staged earlier in the statement/transaction are reverted by the
  existing deferred-rollback snapshot machinery (`txn-bridge.ts` restores each dirty tree's
  pre-stage snapshot on rollback) — the sibling fix
  `optimystic-deferred-constraint-rejection-not-rolled-back`.
- **Idiomatic error.** Throws Quereus's `ConstraintError` (code `StatusCode.CONSTRAINT`)
  rather than a plain `Error`, so the engine applies SQL conflict semantics. The `update`
  catch block was adjusted to rethrow any `QuereusError` verbatim (it previously re-wrapped
  every error in a plain `Error`, which would have erased the constraint classification).

### SQL conflict semantics (observed, matches SQLite OR ABORT)

A duplicate insert mid-transaction aborts only the **offending statement**; the surrounding
transaction keeps going. So `begin; insert(1,'a'); insert(1,'b') -- rejected; commit`
persists `(1,'a')` (count 1), it does NOT roll the whole transaction back. The regression
test asserts exactly this (an initial wrong assumption that the whole txn rolled back was
corrected).

## Validation already performed

- New regression spec `test/insert-pk-uniqueness.spec.ts` (3 cases: duplicate across
  separate transactions + reopen; duplicate staged earlier in the same explicit
  transaction; duplicate within a single multi-row INSERT). All pass; all **failed** on the
  pre-fix code ("expected operation to throw, but it resolved").
- `test/deferred-constraint-rollback.spec.ts` still green (no atomicity regression).
- Full package suite: **215 passing, 5 pending** (`yarn test`, which runs mocha directly on
  the TS sources via `register.mjs` — it does not invoke `tsup`/dts).
- `optimystic-module.ts` typechecks clean (zero errors attributable to this change).

## Pre-existing blocker — do NOT chase

`yarn build` (tsup with `dts: true`) and `yarn typecheck` fail with libp2p type-skew errors
**confined to `src/optimystic-adapter/collection-factory.ts` and
`src/optimystic-adapter/key-network.ts`** (duplicate `@libp2p/interface` copies under
nested `node_modules` → incompatible `Libp2p`/`PeerId`/`RSAPublicKey` types). This predates
this ticket and is already tracked as `optimystic-db-p2p-libp2p-dep-skew` (see recent
commits). It is unrelated to the uniqueness change and touches none of the files in this
diff. The JS bundle the tests consume was produced with `npx tsup --no-dts` as a
workaround. Do not file a duplicate triage ticket for it.

## Scope note for the reviewer (distributed mode)

This fix enforces PK uniqueness against **locally-visible** state (committed + staged),
which fully covers the bootstrap/single-node / `local` transactor case the ticket calls
out. It does **not** add cross-node consensus-level conflict detection: two nodes inserting
the same key concurrently before they sync is a separate, consensus-layer concern (the
collection's `filterConflict` / transactor commit path) and is out of scope here. Worth a
sentence in the review handoff; not a defect of this change.

## Downstream (separate repo — informational)

The sereus-side KNOWN GAP test flip in `strand-membership-invite.spec.ts` is tracked in
sereus as `flip-strand-membership-invite-known-gap`; the sereus control-layer audit
(`CadreControl.FormationInvite.Token`, `CadreControl.Strand.Id`, `FormationUsage`) is a
sereus concern. Nothing to do here beyond landing this optimystic fix (sereus consumes it
via root `resolutions`, same cross-repo pattern as
`optimystic-deferred-constraint-rejection-not-rolled-back`).

## TODO

- Review the diff in `optimystic-module.ts` (insert-branch uniqueness check + the
  `QuereusError` rethrow in the `update` catch) for correctness and style fit.
- Re-run `yarn test` in `packages/quereus-plugin-optimystic` to confirm green (215 passing).
- Confirm the dep-skew build failure is unchanged/pre-existing (it is) and leave it to the
  `optimystic-db-p2p-libp2p-dep-skew` track; do not attempt to fix it here.
- (Optional) Decide whether the `ConstraintError` message wording should match SQLite's
  exact format more closely; current wording is `UNIQUE constraint failed: <table> primary
  key '<key>'`.
- Produce the review/ handoff, noting the distributed-mode scope limitation above as a known
  (intentional) gap, not a bug.
