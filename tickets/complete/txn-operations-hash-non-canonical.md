description: Two honest nodes could compute different fingerprints for the same set of transaction changes because the fingerprint depended on listing order; this extracted one shared, canonical fingerprinting module so sender and validator can never disagree.
files:
  - packages/db-core/src/transaction/operations-hash.ts (shared module: Operation, collectOperations, hashOperations, canonicalStringify)
  - packages/db-core/src/transaction/coordinator.ts (imports shared module; local Operation type + hashOperations + inlined collect removed)
  - packages/db-core/src/transaction/validator.ts (imports shared module; local Operation type + collectOperations + hashOperations removed)
  - packages/db-core/src/transaction/index.ts (exports new module)
  - packages/db-core/test/operations-hash.spec.ts (order-independence + canonicalizer tests)
----

# Complete: shared, canonical operations-hash module

## What shipped

The transaction "operations hash" (fingerprint a coordinator sends in
`PendRequest.operationsHash`, a validator recomputes to accept/reject) was
`ops:${hashString(JSON.stringify(operations))}` over a list built from `Map`/object
iteration order and never canonicalised. Two honest nodes could serialise the same
logical operation set differently → different hash → valid transaction rejected with
`Operations hash mismatch`. The `Operation` type, collect logic, and `hashOperations`
were also copy-pasted across `coordinator.ts` (commit + execute) and `validator.ts`.

New module `operations-hash.ts` is now the single source of truth:
- Operations sorted by tuple `(collectionId, blockId, type)` — string compare on the
  first two, fixed `TYPE_RANK` (insert<update<delete) on the third.
- `canonicalStringify`: recursively sorts object keys, preserves array element order,
  mirrors `JSON.stringify` leaf semantics.
- `ops:` prefix + `hashString` retained — on-the-wire format unchanged.
- Coordinator and validator both import `collectOperations` + `hashOperations`; all
  three inlined collect sites and both `hashOperations` methods deleted.

## Review findings

Adversarial pass over the implement diff (commit `5498821`), read before the handoff.

**Checked — correctness of the cross-node contract (no defect found):**
- **Ordering / tiebreak.** `compareOperations` is a total order; when the same
  `(collectionId, blockId)` carries insert+update+delete, `TYPE_RANK` disambiguates
  deterministically. Equal-comparing ops (only possible via duplicate blockId in a
  `deletes` array) are byte-identical, so hash is unaffected. Sound.
- **String comparison determinism.** `<`/`>` on `collectionId`/`blockId` is UTF-16
  code-unit order — engine-independent, locale-free (implementer correctly avoided
  `localeCompare`). base64url ids are ASCII. Stable across nodes.
- **Array-order preservation.** `canonicalStringify` maps arrays (never sorts);
  nested data arrays inside an `IBlock` and `BlockOperations` tuples are preserved.
  Verified by the reorder test and by code.
- **Leaf semantics.** `undefined`/function/symbol dropped in objects, `null` in
  arrays; non-finite → `null`; `-0` → `0`; bigint throws (matches `JSON.stringify`).
  Output is unambiguous (proper JSON quoting on keys/strings), so distinct structures
  cannot collide pre-SHA.
- **No straggler call sites.** grep confirms `hashOperations`/`collectOperations` are
  defined only in the module and consumed only by coordinator + validator. Removed
  `Operation` type + methods were private; no non-`db-core` code imported them.
  `db-p2p` consumes only the `operationsHash` **string** on the wire (format unchanged).
- **Import paths.** `../blocks/structs.js`, `../collection/struct.js`,
  `../transform/struct.js`, `../utility/hash-string.js` all exist.

**Test coverage — judged sufficient at unit level (no new ticket):**
The refactor makes both sender and validator call the *identical* shared functions,
so a unit test exercising `collectOperations` + `hashOperations` directly IS the
cross-node contract. An end-to-end coordinator-vs-validator test would re-run the same
code path and catch nothing more — deliberately not filed. The 7 spec cases cover
order-independence (collection/block/delete/object-key ordering), prefix retention,
and two negative guards (changed value, reordered array) against a degenerate encoder.

**Fixed inline (minor):**
- Added a greppable `NOTE:` at `hashOperations` documenting the mixed-version cluster
  concern at the code site (was only in the handoff prose before) — see tripwire.

**Tripwires (parked, not tickets):**
- **Mixed-version hash skew.** Canonical encoding differs from the old raw-JSON one,
  so the hash value changed. Same-version clusters unaffected (recomputed fresh, never
  persisted), but there is no protocol-version gate — an old node and a new node in one
  cluster would reject each other with `Operations hash mismatch`. Genuinely conditional
  (only matters *if* Optimystic ships rolling upgrades). Recorded as a `NOTE:` at
  `hashOperations` in `operations-hash.ts`.
- **`canonicalStringify` has no `toJSON`/Date special-casing.** A `toJSON`-bearing value
  encodes as its plain enumerable keys, not `JSON.stringify`'s toJSON string. Harmless
  today (blocks hold plain JSON) and still deterministic (both sides run the same
  encoder). Only work if `IBlock` grows toJSON-bearing values *and* exact `JSON.stringify`
  parity matters. Already `NOTE:`-commented at the function.

**Not filed / left as-is:**
- `canonicalStringify` is exported publicly (via `transaction/index.ts`) mainly for the
  test. A public canonicalizer is harmless and mildly useful; narrowing is not worth a
  ticket.

## Validation

- `yarn workspace @optimystic/db-core build` — clean, exit 0.
- `eslint` on `operations-hash.ts` + `operations-hash.spec.ts` — clean, exit 0.
- `yarn workspace @optimystic/db-core test` — **1166 passing, 0 failing** (~6s),
  including the 7 new `operations-hash.spec.ts` cases.
