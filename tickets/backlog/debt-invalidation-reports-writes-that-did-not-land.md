description: When a disputed transaction is reversed, the code writes the corrected block contents but never checks whether the write actually took effect — if a newer update landed first the write is silently skipped, yet the permanent record still claims the reversal happened.
files:
  - packages/db-p2p/src/dispute/invalidation.ts (applyInvalidation — the per-block apply loop and the `reverted` array it builds)
  - packages/db-p2p/src/storage/i-block-storage.ts (saveReplica / saveDeletion — both return the effective latest, documented as a no-op when already at or past that revision)
severity: wrong-result
likelihood: unusual
tradeoffs: The whole dispute/reversal subsystem is switched off on every live node today, so this cannot bite a real user until that subsystem is activated — a maintainer could reasonably fold it into the activation work instead of fixing it standalone.
----

# An invalidation can record a reversal that never happened

## What goes wrong

Reversing a disputed transaction ("invalidation") works in two steps per affected block:

1. Read the block and compute what its contents *should* be with the disputed transaction removed.
2. Write that content back as a new revision.

Step 1 runs **outside** the block's write lock; only step 2 takes the lock. So another writer can
commit a newer revision of the same block in between. When that happens the write in step 2 is
correctly refused — both write paths (`saveReplica` for a content restore, `saveDeletion` for a
block-creation reversal) are deliberately monotonic and do nothing when the block is already at or
past the revision being written. Each returns the revision that is actually in effect afterwards, so
the caller can tell a real write from a refused one.

`applyInvalidation` throws that return value away. It then unconditionally records the block in its
`reverted` list, with the content hash it *computed* in step 1, and appends that list to the
append-only invalidation log — which is the durable source of truth other nodes and the cascade
logic read. The result is a permanent record asserting a block was restored to content it was never
restored to.

## Why it matters downstream

The `reverted` entries are not cosmetic. `restoredContentHash` is what the cascade uses to decide
which *other* transactions read now-invalid content and must themselves be reversed. A wrong hash
there propagates the error outward: dependents can be reversed on the strength of a restore that
did not occur, or spared one that did.

## The invariant to establish

> An invalidation log entry names a block only when that block's compensating write actually landed,
> and the content hash it records is the content that is actually in effect.

Fixing the one discarded return value is the minimum. Worth considering while shaping the work:
whether the compute step should move inside the block write lock so the refusal cannot arise at all,
and what the right outcome is for a block whose write was refused — skip it from `reverted`, retry
at a higher revision, or fail the whole invalidation. That choice is a correctness decision about
the reversal protocol, not a local cleanup, and should be settled before implementing.

## Status and provenance

- **Pre-existing**, not introduced by the one-block-one-write-lock change: the previous code shape
  (`runLatched(() => storage.saveDeletion(...))`) discarded the same value. Found while reviewing
  that change.
- **Currently dormant.** The dispute subsystem is not registered on any live node, so nothing
  originates an invalidation in production today. That is why this is filed as debt rather than a
  bug — but it is a real defect the moment the subsystem is switched on and two writers touch one
  block concurrently.
- Related but distinct from `invalidation-live-wiring-requires-arbitrator-set-anchoring` (that one is
  about verifying *who* authorized a reversal; this one is about whether the reversal it authorizes
  actually took effect) and from `feat-dispute-subsystem-live-activation` (the activation itself).
