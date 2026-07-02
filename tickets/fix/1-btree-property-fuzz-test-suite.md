----
description: Add a randomized stress test for the sorted-key index that compares it against a simple reference map across many random insert, delete, lookup, and range operations at varying data sizes, to catch rare rebalancing and iteration bugs.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.spec.ts, packages/db-core/test/transform.property.spec.ts (existing property-test pattern to follow)
difficulty: medium
----
The review's highest-leverage single recommendation: the B-tree's rare rebalance branches and iteration cracks are exactly where testing thins, and that is where several real correctness bugs live. A property/fuzz test would mechanically surface them.

Build a randomized property test that drives the B-tree with a random mix of `insert`, `delete`, `find`, and `range` operations and, after each operation (or each batch), checks the tree against a reference model — a plain sorted map / array — for equivalence: every present key is findable, absent keys are not, full-order iteration matches, and range scans from arbitrary start keys (including keys that fall between entries and at leaf boundaries) return exactly the reference's slice.

Run it at multiple tree heights by using enough entries to force several internal levels (thousands of entries), and with small node fan-out configurations if available, so borrow/merge and multi-level rebalance paths are exercised frequently. Use a fixed, logged seed so failures are reproducible, and shrink or record the failing operation sequence.

This suite is expected to catch the borrow-from-right wrong-partition-key bug, the internal-merge separator corruption, the end-of-leaf range-scan stall, and the branch left-merge index bug (tracked separately as their own fix tickets). It can be developed alongside those fixes; expect it to fail until they land, which is the point — it should stay in the suite as a permanent guard.

Expected outcome: a seeded, reproducible property test in the db-core test suite that fails on the known rebalance/iteration bugs and passes once they are fixed.
