description: Two honest nodes can compute different fingerprints for the very same set of changes, because the fingerprint depends on the order things happen to be listed rather than a fixed canonical order — so a node validating another node's work can wrongly reject it. The fingerprinting code is also copy-pasted in two files, guaranteeing they will eventually disagree.
files:
  - packages/db-core/src/transaction/coordinator.ts (operations collect + hash, ~lines 162-174)
  - packages/db-core/src/transaction/validator.ts (operations collect + hash, ~lines 149-170)
difficulty: medium
----

# Operations hash is non-canonical — honest validators can diverge

## The bug

The operations hash is `JSON.stringify` over operations in Map-insertion order. The
sender iterates in action/collection-data order; the validator iterates in its own
collection-registration order. Nothing canonicalizes collection order, per-collection
block order, or object key order. So an honest re-execution can produce a *different*
hash for identical operations → spurious "Operations hash mismatch" rejections.

The collect-and-hash logic is also duplicated verbatim between `coordinator.ts` and
`validator.ts`, so the two will inevitably drift out of sync.

## Expected behavior

Any two honest nodes that see the same logical set of operations compute the same
hash, independent of iteration/insertion order, and there is a single source of truth
for how the hash is computed.

## Suggested direction (hint, not a mandate)

Sort operations deterministically by (collectionId, blockId, type), serialize with a
canonical JSON encoding (sorted object keys), and extract one shared hashing module
imported by both the coordinator and the validator so the two can never diverge.

Note: although the review tags this "design", the correction is well-specified (a
known canonical form), so it is filed as a fix. The one cross-node contract to nail
down is the exact canonical ordering/encoding — settle it once in the shared module.

Severity: MEDIUM.
