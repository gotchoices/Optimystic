description: Two honest nodes could compute different fingerprints for the same set of transaction changes because the fingerprint depended on listing order; this extracts one shared fingerprinting module so sender and validator can never disagree.
files:
  - packages/db-core/src/transaction/operations-hash.ts (NEW — the shared module: Operation type, collectOperations, hashOperations, canonicalStringify)
  - packages/db-core/src/transaction/coordinator.ts (now imports the shared module; local Operation type + hashOperations method + inlined collect removed)
  - packages/db-core/src/transaction/validator.ts (now imports the shared module; local Operation type + collectOperations + hashOperations removed; stale "must match coordinator.ts" comment gone)
  - packages/db-core/src/transaction/index.ts (exports the new module)
  - packages/db-core/test/operations-hash.spec.ts (NEW — order-independence + canonicalizer tests)
difficulty: medium
----

# Review: shared, canonical operations-hash module

## What the implement stage did

The transaction "operations hash" (the fingerprint a coordinator sends in
`PendRequest.operationsHash` and a validator recomputes to accept/reject a
transaction) was `` `ops:${hashString(JSON.stringify(operations))}` `` where
`operations` was built from `Map`/object iteration order and never canonicalised.
Two honest nodes could serialise the same logical operation set differently and so
compute different hashes → a valid transaction rejected with
`Operations hash mismatch`. The `Operation` type, the collect logic, and
`hashOperations` were also copy-pasted across `coordinator.ts` (twice — in
`commit()` and `execute()`) and `validator.ts`.

Implemented exactly as the ticket's "suggested shape":

- **New module** `packages/db-core/src/transaction/operations-hash.ts` exporting
  `Operation`, `collectOperations`, `hashOperations`, and (for the test) the
  internal `canonicalStringify`.
- **Canonical form (the cross-node contract):**
  - Operations sorted by the tuple `(collectionId, blockId, type)` — string compare
    on the first two, a fixed `TYPE_RANK` on `type`. Rank is the **semantic apply
    order** `insert(0) < update(1) < delete(2)`, defined in exactly one place.
  - Encoded with `canonicalStringify`: **recursively sorts object keys**,
    **preserves array element order**, mirrors `JSON.stringify` leaf semantics
    (`undefined`/function/symbol object-values dropped, same in arrays → `null`,
    `null` → `null`, non-finite numbers → `null`, other primitives via
    `JSON.stringify`).
  - Keeps the `` `ops:` `` prefix + `hashString` (SHA-256 → base64url), so the
    **on-the-wire hash string format is unchanged**.
- Coordinator and validator now both import `collectOperations` + `hashOperations`;
  all three inlined collect sites and both `hashOperations` methods deleted.
- Exported through `transaction/index.ts` (which `db-core/src/index.ts` already
  re-exports — no second top-level export added).

## Validation performed

- `yarn workspace @optimystic/db-core build` — clean (artifact emitted, no TS errors).
- `yarn workspace @optimystic/db-core test` — **1166 passing, 0 failing.**
- New `operations-hash.spec.ts` — 7 passing:
  - same hash for two `Map<CollectionId, Transforms>` with identical logical ops but
    different collection-insertion order, different block-key insertion order,
    reversed `deletes` order, and one block with reversed object-key insertion order
    (incl. reversed nested-object keys);
  - `ops:` prefix retained;
  - **different** hash when a block value changes (guards against a degenerate
    canonicalizer that collapses everything);
  - **different** hash when a `BlockOperations` array is reordered (guards array-order
    preservation);
  - `canonicalStringify` unit checks: key-sort vs. array-order, undefined/null leaf
    semantics.

## What the reviewer should scrutinise (the cross-node contract)

This is a **wire-level agreement between distinct nodes** — the parts worth an
adversarial eye:

1. **Ordering choice.** Sort key `(collectionId, blockId, type)`, `type` tiebroken by
   `TYPE_RANK`. Confirm the same `(collectionId, blockId)` carrying insert+update+delete
   in one transform (block staged→mutated→deleted) sorts deterministically. The rank
   value is arbitrary for correctness *as long as it lives in one place* — it does
   (`TYPE_RANK` in the module). Plain string compare on `collectionId`/`blockId`: these
   are base64url `BlockId`s, so `<`/`>` byte-ish ordering is stable and locale-free.
2. **Array-order preservation.** `BlockOperations` is an ordered list of
   `[entity, index, deleteCount, inserted]` tuples whose order is semantically
   meaningful; `canonicalStringify` must NOT sort arrays. The reorder test covers the
   top-level ops array; eyeball that a nested data array inside an `IBlock` is likewise
   preserved (it is — arrays are mapped, not sorted).
3. **Leaf semantics.** `canonicalStringify` hand-rolls `JSON.stringify` leaf behaviour.
   Check the `undefined`-in-object-drop vs. `undefined`-in-array→`null` split, and
   non-finite→`null`. See the tripwire below for the one deliberate divergence.

## Tripwire (parked, not a ticket)

- **`canonicalStringify` has no `toJSON`/Date special-casing.** A `toJSON`-bearing
  value (e.g. a `Date`) encodes as its plain enumerable keys (`{}` for a Date), not
  `JSON.stringify`'s toJSON string. Harmless today — blocks hold plain JSON — and still
  deterministic across nodes (both sides run the same encoder, so they still agree).
  Only becomes work if `IBlock` content ever grows toJSON-bearing values *and* exact
  `JSON.stringify` parity matters. Parked as a `NOTE:` comment at the function in
  `operations-hash.ts`.

## Honest gaps / things NOT done

- **Hash value changed vs. the old encoding (rollout consideration, not a bug).** The
  canonical encoding differs from the old raw `JSON.stringify`, so the *hash string a
  given transaction produces* is different from pre-change. Within one deployment this
  is a non-issue (the hash is computed fresh on both sender and validator, never
  persisted or version-negotiated). But in a **mixed-version cluster** — an old node
  (raw-JSON hash) validating a new node's transaction (canonical hash), or vice-versa —
  the two would disagree and reject each other with `Operations hash mismatch`, exactly
  the failure mode we fixed, but now version-skew-induced. There is no protocol version
  gate on this hash today. If Optimystic ships rolling upgrades, decide whether that
  needs handling; flagged here rather than assumed safe.
- **No external caller audit gap:** verified the removed `Operation` type and
  `hashOperations`/`collectOperations` were **private/local** — nothing outside
  `db-core` imported them. `db-p2p` (storage-repo, cluster-repo, dispute/types,
  network/struct) only consumes the `operationsHash` **string** field on the wire, whose
  format is unchanged. No non-`db-core` code was touched or needs it. (Not re-built
  `db-p2p` — its interface to this is the unchanged string.)
- **Order-independence tested at unit level only** (direct `collectOperations` +
  `hashOperations` on hand-built `Transforms` maps). There is no end-to-end test driving
  a real coordinator-vs-validator disagreement across two coordinators with divergent
  collection-registration order. The unit test is the floor, not the ceiling — a
  cluster-level regression test would be stronger if cheap to add.
- `canonicalStringify` is exported publicly (through `transaction/index.ts`) mainly so
  the test can exercise it. If a narrower public surface is preferred, it could be kept
  module-internal and the test could import it via a deep path instead.
