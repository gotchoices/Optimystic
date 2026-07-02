description: When a node tries to recover a missing block from its peers, it computes which peers are responsible using a different addressing scheme than the one the network actually uses — so it asks the wrong peers and ignores the right ones, and the fallback recovery path effectively never works.
prereq:
files: packages/db-p2p/src/storage/restoration-coordinator-v2.ts
difficulty: medium
----

# Restoration filters by the wrong coordinate space — "hash the block ID" doesn't hash

`extractBlockPrefix` in the restoration coordinator copies the raw first bytes of the blockId
string (`restoration-coordinator-v2.ts:136-153`). But cohort assembly and ring partitioning use
`hashKey(blockIdBytes)` — peer responsibility is computed from **hashed** coordinates, not raw
blockId bytes.

`filterByPartition` therefore compares a raw-byte prefix against hashed-coordinate partitions.
The two coordinate spaces are unrelated, so the inner-ring fallback path queries peers that are
**not** responsible for the block and filters **out** the peers that are — the fallback
restoration path is effectively broken for every block.

Expected behavior: the prefix used to select responsible peers is derived from the same
coordinate the rest of the system uses for cohort assembly — `hashKey(encode(blockId))`. After
the fix, `filterByPartition` selects the peers actually responsible for the block, so the
inner-ring fallback queries the right cohort.

## Reproduction notes

- Construct a blockId whose raw-byte prefix and `hashKey`-derived prefix fall in different ring
  partitions, and assert `filterByPartition` (via the fallback path) selects the peers matching
  the hashed coordinate, not the raw prefix.

Suggested-fix hint: compute the prefix from `hashKey(encode(blockId))` — the identical
coordinate used for cohort assembly — rather than slicing raw blockId string bytes.
