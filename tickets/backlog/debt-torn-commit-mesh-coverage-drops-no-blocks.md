description: The end-to-end test for a half-completed write only covers the case where nothing is actually lost, so half of the fix that makes such a write recover has no whole-system test behind it.
files:
  - packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts (the "a torn commit" test and its `tearFirstCommit` helper)
  - packages/db-p2p/src/storage/storage-repo.ts (the pend-time own-revision carve-out that goes uncovered)
  - packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/cluster-pend-staleness.spec.ts (the unit-level coverage that does exist)
difficulty: medium
tradeoffs: Both halves of the fix already have direct unit tests at their own layer, so this only buys confidence that they compose — and building it means driving a non-diary collection through the mesh harness, which is more setup than the finding is obviously worth.

# The torn-commit mesh test cannot reach the pend-side half of the fix

## Background

A write commits its blocks in stages, so a write can end up **half done**: the part that records
"this happened" is permanently stored, but a later block loses a race and the writer is told the
whole write failed. Recovering from that needs two things to be true when the writer retries:

1. **On the storage side** — the retry must not be refused for colliding with *its own* already-
   stored work. (Without this the writer retries forever against itself.)
2. **On the writer's side** — the retry must recognize its own already-recorded entry and not
   record it a second time. (Without this the same write shows up twice.)

Both landed, and each has a direct unit test at its own layer.

## The gap

The one whole-system test that exercises a half-done write drives a **diary append**. A diary
append writes nothing but the log itself — so the "half" that gets dropped is empty, and the
writer never gets far enough to retry against storage at all. The test therefore exercises point 2
only. Measured directly: disabling the storage-side carve-out leaves the test green; disabling the
writer-side one makes it fail with exactly the duplicate it is meant to catch.

So the two halves have never been shown to work **together** on a real mesh, which is the only
place their interaction actually happens.

## What would close it

A whole-system test over a collection whose write touches blocks beyond the log — a tree write is
the obvious candidate — torn the same way the existing test tears a diary append, asserting that
the writer recovers and the write lands exactly once. The existing `tearFirstCommit` helper in
that spec file already does the tearing and records how many blocks it dropped; the test should
assert that number is greater than zero, which is precisely what the diary case cannot do.

Worth checking while doing this whether the helper belongs in the shared mesh test harness rather
than in one spec file, since a second consumer is exactly what this ticket creates.

## Related, and it shares a fixture with this one (backlog gardening, 2026-09-01)

`debt-mesh-harness-policy-and-commit-path-untested` arm two wants the same thing this ticket wants
from a different angle: a mesh-level case that drives a commit the committing node cannot satisfy from
what it holds locally. Every existing mesh case enters from the read side.

The two were deliberately **not** merged — they cover different production code and assert different
things. But the body's own closing suggestion (that `tearFirstCommit` "belongs in the shared mesh test
harness rather than in one spec file, since a second consumer is exactly what this ticket creates") is
now concrete: that second consumer is the other ticket's arm two. Whichever is picked up first should
land the helper in `packages/db-p2p/src/testing/mesh-harness.ts`, not in its own spec.
