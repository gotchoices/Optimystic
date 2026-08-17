----
description: To reduce false conflicts, a lookup deliberately forgets most of the blocks it passed through on the way to its answer. The argument for why that is safe has never been tested against a real competing writer — only against hand-written stand-ins.
files:
  - packages/db-core/test/occ-structural-read-exclusion.spec.ts (the "validator consequence of the reduced read set" describe — the synthetic half)
  - packages/db-core/test/read-dependency-e2e.spec.ts (the real-rival pattern to copy, but single-level)
  - packages/db-core/src/testing/test-transactor.ts (commitRivalTreeWrite — needs a fan-out parameter, see its own NOTE)
  - docs/correctness.md (Theorem 5 — the safety argument being tested)
difficulty: hard
tradeoffs: The safety argument is proved on paper and each half is tested in isolation, so this buys confidence rather than coverage of a known defect — and getting two independent writers to agree on tree fan-out needs a change to a shared test helper before the test can even be written.
----

# The gap

Optimystic detects conflicting concurrent work by recording which blocks a transaction read, then
rejecting the transaction if any of those blocks changed before it committed. To avoid rejecting
transactions that never really conflicted, a B-tree point lookup **deliberately drops** most of what
it read: walking from the root down to the leaf that holds a key touches several interior branch
blocks, and those are tagged `navigation` and excluded from the conflict set. Only the final leaf —
the block that actually carries the answer — is retained.

The safety argument for that exclusion (`docs/correctness.md` Theorem 5) is: any concurrent change
that would alter the answer must also modify the retained leaf, so dropping the interior blocks can
never let a conflicting write slip through unnoticed. If that argument is wrong, the failure mode is
a **lost update** — two writers both commit and one silently overwrites the other — not a spurious
rejection. That is the most expensive kind of bug this system can have.

Today that argument is never exercised end to end. The two halves are each tested, separately:

- **Capture half** — `occ-structural-read-exclusion.spec.ts` builds a genuinely multi-level tree
  (small fan-out) and proves the interior blocks really do drop out of the recorded set while the
  leaf stays.
- **Rejection half** — the same file's "validator consequence" tests feed the validator two
  hand-written block ids (`'leaf-block'`, `'interior-block'`) and a hand-written map of revision
  numbers. No tree, no writer, no storage.

So nothing anywhere drives: *a real multi-level tree, read by one client, then restructured by a
second real client, validated for real.* A restructuring rival is exactly the case the exclusion is
betting on — a split or merge that rewrites interior blocks — and it is the one case never run.

`read-dependency-e2e.spec.ts` (the file this gap was noticed from) does drive a real rival end to
end, but its tree is a single node at the default fan-out of 64, so root and leaf are the same block
and there are no interior blocks to exclude. It cannot reach this case.

# What good looks like

A test in which two independent writers operate on the same multi-level tree through the same
transactor:

- one client reads a key, capturing a reduced read set (leaf retained, interior dropped);
- a second, genuinely separate client commits a write that **restructures** the tree — enough
  insertions or deletions to force a split or merge at a level above the reader's leaf;
- the reader's captured set is then validated for real.

Two outcomes must be distinguished, and both are interesting:

- the restructuring **moved the reader's key** (or changed what a lookup for it would return) —
  the retained leaf must have moved too, and validation must reject. This is Theorem 5's core claim.
- the restructuring **only touched blocks the reader navigated through**, leaving the reader's
  answer intact — validation must pass, no false rejection.

Ideally this is a generator rather than two fixed scenarios: random key sets, random fan-out, a
random rival mutation, asserting the invariant "the reader is rejected if and only if the answer it
observed is no longer the answer". `packages/db-core/test/btree.property.spec.ts` already
demonstrates the multi-level-tree generator style this could build on.

# Known obstacle

Tree fan-out is not stored in the collection header, so two clients opening the same collection can
disagree about it and split nodes at different points. `commitRivalTreeWrite` in
`packages/db-core/src/testing/test-transactor.ts` opens the rival at the hard-coded default of 64,
and its own `NOTE:` already calls out that racing a small-fan-out tree needs a capacity parameter
threaded through both sides. That parameter is a prerequisite for writing this test at all.
