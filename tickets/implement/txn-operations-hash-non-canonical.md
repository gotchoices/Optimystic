description: Two honest nodes can compute different fingerprints for the same set of changes because the fingerprint depends on listing order rather than a fixed canonical order, so a node validating another node's work can wrongly reject it. Extract one shared fingerprinting module so the sender and validator can never disagree.
files:
  - packages/db-core/src/transaction/coordinator.ts (Operation type ~15-18; inlined collect+hash in commit ~181-193 and execute ~460-471; hashOperations ~388-391)
  - packages/db-core/src/transaction/validator.ts (Operation type ~11-14; collectOperations ~149-161; hashOperations ~167-170)
  - packages/db-core/src/transaction/index.ts (add export of new shared module)
  - packages/db-core/src/transform/struct.ts (Transforms shape — reference)
  - packages/db-core/src/blocks/structs.ts (IBlock, BlockOperations — reference)
  - packages/db-core/src/utility/hash-string.ts (hashString — the underlying digest)
  - packages/db-core/test/transaction.spec.ts (existing operationsHash coverage; add order-independence test here or in a new spec)
difficulty: medium
----

# Operations hash is non-canonical — honest validators can diverge

## The bug (confirmed)

The transaction "operations hash" is `` `ops:${hashString(JSON.stringify(operations))}` ``.
The `operations` array is built by `flatMap`-ing over `Map`/object iteration order and is
never canonicalized, so the same logical set of operations serializes differently on the
sender vs. a validator re-executing it. Three independent sources of order-dependence:

1. **Collection order** — `Array.from(collectionTransforms.entries())` /
   `transforms.entries()` yields `Map` insertion order. The sender inserts in
   action/collection-data order; the validator inserts in its own
   collection-registration order.
2. **Per-collection op order within a collection** — inserts come from
   `Object.entries(transforms.inserts)`, updates from `Object.entries(transforms.updates)`,
   in object-key insertion order; nothing sorts by blockId.
3. **Object key order inside each block** — `JSON.stringify` emits keys in insertion
   order, so an `IBlock` (data blocks carry arbitrary nested fields beyond `header`) with
   the same content but different key-insertion order stringifies differently.

Any of these differing between two honest nodes yields a different hash →
`validator.ts:130` returns `{ valid: false, reason: 'Operations hash mismatch' }` for a
perfectly valid transaction.

Reproduction path (unit-level, no cluster needed): call the collect+hash logic on two
`Map<CollectionId, Transforms>` that carry the **same** logical operations but with
collections inserted in a different order, block keys inserted in a different order, and
one block's object keys in a different order. Today the two hashes differ; after the fix
they must be equal. See the sender path at `coordinator.ts:181-193` and the validator
path at `validator.ts:120-124`.

## Duplication (also confirmed)

The `Operation` union type, the collect-from-transforms logic, and `hashOperations` are
copy-pasted between `coordinator.ts` and `validator.ts` (coordinator has the collect step
inlined in **both** `commit()` and `execute()`). `validator.ts:9` even carries a comment
"Must match the Operation type in coordinator.ts" — a hand-maintained invariant that will
drift. There must be exactly one source of truth.

## Expected behavior

Any two honest nodes that see the same logical set of operations compute the **same**
hash, independent of `Map`/object insertion order, and there is a single shared module
that both the coordinator and the validator import for both *collecting* operations and
*hashing* them.

## The canonical form (the cross-node contract — settle it here, once)

This is the one thing that must be pinned down and never quietly changed, because it is a
wire-level agreement between distinct nodes. Fix it as:

**Operation shape** (unchanged from today's union):
```ts
type Operation =
  | { type: 'insert'; collectionId: CollectionId; blockId: BlockId; block: IBlock }
  | { type: 'update'; collectionId: CollectionId; blockId: BlockId; operations: BlockOperations }
  | { type: 'delete'; collectionId: CollectionId; blockId: BlockId };
```

**Ordering** — sort the full operations list by the tuple
`(collectionId, blockId, type)` using plain string comparison on each component. `type`
is the tiebreaker because the same `(collectionId, blockId)` can legitimately carry an
insert *and* an update *and* a delete (a block staged then mutated then deleted within one
transform — see the `Transform`/`Transforms` apply-order note in
`transform/struct.ts:15-16`). Use a fixed `type` rank; either alphabetical
(`delete < insert < update`) or the semantic apply order (`insert < update < delete`) is
fine **as long as it is defined in exactly one place** — since both sides call the same
module, the choice only has to be internally consistent. Prefer the semantic apply order
for readability.

**Encoding** — serialize with a canonical JSON encoder that **recursively sorts object
keys** but **preserves array element order**. Array order must be preserved because
`BlockOperations` is an ordered list of `[entity, index, deleteCount, inserted]` tuples
whose order is semantically meaningful (and any data arrays nested inside an `IBlock`
likewise). `deletes` order does *not* matter and is already normalized by the
operation-level sort above (each delete is its own `Operation`). Match `JSON.stringify`
semantics for the leaves: `undefined` object-values are dropped (as `JSON.stringify`
does), `null` encodes as `null`, primitives via `JSON.stringify`.

**Prefix** — keep the existing `` `ops:` `` prefix and `hashString` (SHA-256 →
base64url) so the hash string format is unchanged on the wire.

## Suggested shape

Create `packages/db-core/src/transaction/operations-hash.ts` exporting:

- `Operation` (the union above)
- `collectOperations(transforms: Map<CollectionId, Transforms>): Operation[]` — the
  collect step, shared by coordinator (both `commit()` and `execute()`) and validator
- `hashOperations(operations: readonly Operation[]): Promise<string>` — sorts, canonical-
  stringifies, prefixes, hashes

Keep the canonical-JSON encoder as an internal helper in that module (it has no other
caller today); export it too if that makes the order-independence test cleaner. Wire the
new module through `transaction/index.ts`. Then delete the duplicated `Operation` type,
`hashOperations`, and collect logic from both `coordinator.ts` and `validator.ts`,
replacing the three inlined collect sites and two `hashOperations` methods with imports.

Note: `db-core/src/index.ts` re-exports `transaction/index.js` already, so exporting from
`transaction/index.ts` is sufficient — do not add a second top-level export.

## TODO

- Add `packages/db-core/src/transaction/operations-hash.ts` with `Operation`,
  `collectOperations`, `hashOperations`, and an internal recursive canonical-JSON encoder
  (sorted keys, preserved array order, `JSON.stringify` leaf semantics).
- Sort operations by `(collectionId, blockId, type)` with a single fixed `type` rank
  defined in that module.
- Export the new module from `packages/db-core/src/transaction/index.ts`.
- Refactor `coordinator.ts`: remove its local `Operation` type and `hashOperations`;
  replace the inlined collect+`flatMap` in `commit()` (~181-193) and `execute()`
  (~460-471) with `collectOperations(...)` + `hashOperations(...)` from the shared module.
- Refactor `validator.ts`: remove its local `Operation` type, `collectOperations`, and
  `hashOperations`; import from the shared module (drop the stale "Must match … in
  coordinator.ts" comment).
- Add a test (extend `packages/db-core/test/transaction.spec.ts` or add
  `operations-hash.spec.ts`): build two `Map<CollectionId, Transforms>` with identical
  logical operations but different collection-insertion order, different block-key
  insertion order, and one block with different object-key insertion order; assert the two
  `hashOperations(collectOperations(...))` results are **equal**. Add a second assertion
  that different operations still produce different hashes (guard against a degenerate
  canonicalizer that collapses everything).
- Build + test db-core: `yarn workspace @optimystic/db-core build` then
  `yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/dbcore-test.log` (stream, don't
  silently redirect). Fix any type errors from the refactor before handoff.
- Handoff: write a `review/` ticket that flags the canonical form as the cross-node
  contract to scrutinize (ordering choice, array-order preservation, leaf semantics), and
  note whether any non-`db-core` caller relies on the old (now-removed) `Operation`
  export or `hashOperations` signature.
