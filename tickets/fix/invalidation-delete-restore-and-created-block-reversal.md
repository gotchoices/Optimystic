description: When the transaction being undone is the one that first created a data block, the system can't physically remove or re-create that block yet — so undoing such a transaction either throws or just logs a placeholder instead of actually reverting it.
prereq:
files: packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/dispute/cascade.ts
difficulty: hard
----

# Delete-restore: reverse a block-creating transaction (and don't throw on created-at-rev>1)

## Background

`computeRevertedBlock` (`packages/db-p2p/src/dispute/invalidation.ts`) reconstructs an as-if-`T_inv`-absent
block from stored revisions. Two cases involving a *block-creating* transaction are unfinished:

1. **Creation at `invalidatedRev <= 1`** — recognized as `{ kind: 'delete' }`, but the apply primitive does
   NOT physically remove the block: it records the `DEFERRED_DELETE_RESTORE` sentinel and logs instead
   (`IBlockStorage` exposes no delete-transform write). The 7.5 review flagged this as "deferred to the
   cascade ticket"; the 7.6 cascade ticket deferred it again. So reversing a block-creating `T_inv` leaves
   the created block physically present, only marked.

2. **Creation at `invalidatedRev > 1`** — a block first created by an action at rev > 1 (e.g. a dependent
   that creates a block partway through the log). `computeRevertedBlock` only treats `invalidatedRev <= 1`
   as creation; otherwise it reads `getBlock(invalidatedRev - 1)`, which for a then-nonexistent block fails
   to materialize and **throws** (observed during 7.6 implementation while writing the idempotent test — it
   was worked around by pre-creating the block at genesis). A cascade that needs to revert a dependent which
   created a fresh block will therefore throw rather than revert.

## Why it matters for the cascade

The cascade re-evaluates and reverts arbitrary read-dependents, including ones that *create* blocks. Both
cases above are now reachable from `cascadeInvalidate`:
- the throw (case 2) aborts an otherwise-valid cascade mid-flight;
- the deferred-delete (case 1) leaves the `restoredContentHash = DEFERRED_DELETE_RESTORE` sentinel, which the
  default re-evaluator already treats as "observed content no longer exists → invalidate" — sound, but the
  underlying block is never actually removed, so storage diverges from the logical reverted state.

## Required behaviour

- Detect block creation regardless of revision: a block whose earliest stored revision *is* `invalidatedRev`
  (no `invalidatedRev - 1` content) is a creation, reverted by removal — at any rev, without throwing.
- Provide a delete-transform write path on `IBlockStorage` so the apply primitive can physically reverse a
  creation (remove the block / write a tombstone revision), and a corresponding restore on re-materialization.
- Replace the `DEFERRED_DELETE_RESTORE` sentinel path with the real removal once the storage API exists, or
  document precisely what remains deferred and why.

## Scope notes

Needs an `IBlockStorage` API addition (delete-transform), so it is design work, not a one-line fix — hence
backlog rather than an inline cascade fix. The cascade engine and single-collection reversal otherwise work;
this closes the block-creation corner for both the root reversal (7.5) and the cascade (7.6).
