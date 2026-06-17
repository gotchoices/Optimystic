description: Verify the fix that made peer-to-peer write forwarding ("pend") route by a real block id instead of a structural field name, so writes on a large multi-group network reach a group that can actually handle them.
prereq:
files:
  - packages/db-p2p/src/repo/service.ts (deriveBlockKey pend branch + doc comment + new runtime import)
  - packages/db-core/src/transform/helpers.ts (blockIdsForTransforms — the canonical derivation)
  - packages/db-p2p/test/redirect.spec.ts (reworked pend fixtures + new large-mesh pend regression)
difficulty: easy
----

# Review: `pend` redirect key now derives a block id, not a structural field name

## What changed

`RepoService.deriveBlockKey` derived the redirect routing key for a `pend` op as
`Object.keys(operation.pend.transforms)[0]`. Because `PendRequest.transforms` is shaped
`{ inserts?, updates?, deletes? }` (a `Transforms`), the first key was a **structural field name**
(`'inserts'`/`'updates'`/`'deletes'`), not a block id. `checkRedirect` then hashed a constant and
routed every pend redirect to a fixed, wrong cluster — latent because all existing tests run in a
small mesh (`cluster.length < responsibilityK`) where `checkRedirect` short-circuits to `null`
regardless of the key.

### Production fix (`packages/db-p2p/src/repo/service.ts`)
- Added a **runtime value** import: `import { blockIdsForTransforms } from '@optimystic/db-core'`
  (separate line from the existing `import type { IRepo, RepoMessage }` — it is a value, not a type).
- Pend branch now: `return { blockKey: blockIdsForTransforms(operation.pend.transforms)[0], opName: 'pend' }`.
  This is the same canonical derivation every other consumer uses (`cluster-repo.ts`
  `getAffectedBlockIds` / `validatePendOperations`). Mirrors the earlier `commit` redirect-key fix.
- Updated the `deriveBlockKey` doc comment: `pend → blockIdsForTransforms(transforms)[0]`.
- `undefined` (transforms touch no blocks) is unchanged-correct: caller at `service.ts:217` guards
  `blockKey !== undefined ? checkRedirect(...) : null`, so it's handled locally with no redirect.

### Test rework (`packages/db-p2p/test/redirect.spec.ts`)
- Added `IBlock` to the type import and a `makeBlock(id)` fixture helper
  (`{ header: { id, type: 'test', collectionId: 'c1' } }`).
- The two existing pend fixtures previously passed a **flat, block-id-keyed** object
  (`{ 'block-1': {} }`) that does NOT match the real `Transforms` shape — with the fixed derivation
  that yields `[]` → `undefined`, so they HAD to be reworked. Both now use
  `{ inserts: { 'block-X': makeBlock('block-X') }, updates: {}, deletes: [] }`. The deriveBlockKey
  test title is now "derives pend key from blockIdsForTransforms(...)[0]".
- Added a large-mesh regression `describe('pend redirect keys on blockIdsForTransforms(...)[0] (large mesh)')`
  mirroring the commit large-mesh block: `responsibilityK: 2`, block-A's cluster excludes self,
  the structural-field-name key `'inserts'` falls through to a fallback cluster that includes self.
  It asserts (a) derived key === `'block-A'`, (b) `checkRedirect('block-A', 'pend', …)` fires a
  `not_in_cluster` redirect toward block-A's coordinator excluding self, and (c) the sanity check that
  the OLD key `'inserts'` would NOT redirect (self in fallback) — documenting the misroute removed.

## How to validate

- Build/typecheck: `yarn workspace @optimystic/db-core build` then `yarn workspace @optimystic/db-p2p build` — both clean.
- Targeted: `yarn workspace @optimystic/db-p2p exec node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/redirect.spec.ts" --colors --reporter spec` — 20 passing.
- Full suite: `yarn workspace @optimystic/db-p2p test` — **734 passing, 27 pending, 0 failing** (~31s).

## Reviewer notes / known gaps (treat as a starting point, not a finish line)

- **Coverage is unit-level only.** The regression proves `deriveBlockKey` + `checkRedirect` agree on
  the key in a large mesh; it does NOT exercise an end-to-end multi-node pend that actually misroutes
  and recovers over the wire. No integration test was added — worth a skeptical look at whether the
  unit assertions are a sufficient floor for "writes reach a group that can handle them."
- **`blockIdsForTransforms` returns a `Set`-deduped array with no defined ordering guarantee across
  inserts/updates/deletes.** `[0]` picks "a" touched block, consistent with how `commit` keys on
  `blockIds[0]`. If a pend legitimately spans multiple blocks across different clusters, redirect keys
  on just the first — confirm that matches how pend is coordinated downstream (it mirrors the existing
  commit/cluster-repo behavior, but the reviewer should verify the multi-block-pend case is genuinely
  intended to anchor on one block).
- **Empty-transforms pend** derives `undefined` → handled locally, no redirect. Confirm that's the
  desired behavior for a no-op pend rather than an error.
- The logged line `cohort-topic cold-start: parent registration for tier-1 forwarder failed` during
  the full run is **expected error-logging inside a passing anti-DoS coldstart spec**, not a failure.
- The known-flaky `reactivity / mesh — slow-subscriber isolation` test did **not** fire this run; no
  `.pre-existing-error.md` was needed.
