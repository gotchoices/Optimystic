description: Add property-based tests for Tracker, copyTransforms, isTransformsEmpty, and the Transforms merge/apply semantics. The ticket 5-chain hypothesis — "copyTransforms loses insert+apply pairs on the same block id" — is exactly the shape of bug that a property-based test would have surfaced in CI. Generalize beyond the specific case to cover the whole state-transition space.
dependencies:
  - tickets/fix/5-chain-add-on-fresh-collection-throws-non-existent-chain.md (motivating case)
files:
  - packages/db-core/src/transform/helpers.ts (copyTransforms line 61, isTransformsEmpty line 77)
  - packages/db-core/src/transform/tracker.ts (Tracker class; insert + apply coalescing)
  - packages/db-core/src/transform/atomic.ts (Atomic wrapper, transient layer semantics)
  - packages/db-core/src/transform/cache-source.ts (source-cache interaction)
  - packages/db-core/test/transform.spec.ts (existing example-based tests — augment, don't replace)
  - new: packages/db-core/test/transform.property.spec.ts
  - new dev-dep: `fast-check` (or equivalent) in packages/db-core/package.json
----

## Motivation

Transforms carry the full set of pending mutations (`inserts`, `updates`, `deletes`) between layers: Tracker → snapshot → new Tracker → Log.open → Chain.open. When the same block id gets an `insert` followed by an `apply` (as happens in `Chain.open` when it augments a freshly-inserted Tree header with `headId` / `tailId`), the snapshot must preserve both ops in the right order for the consuming layer to see the fully-applied header.

Example-based tests cover a handful of hand-picked sequences. The actual space is combinatorial: N blocks, each with some sequence of {insert, apply[field=val], delete}, across multiple Tracker-merge boundaries. Ticket 5-chain's root cause is suspected to live in that combinatorial space, and it took a mobile canary to find one specific sequence that breaks.

## Specification

Add a `packages/db-core/test/transform.property.spec.ts` spec that uses `fast-check` (or equivalent) to generate random op sequences and assert invariants. At minimum:

### Round-trip invariants

For any generated `Transforms` value `t`:
- `isTransformsEmpty(copyTransforms(t)) === isTransformsEmpty(t)`
- `copyTransforms(t)` is deep-equal to `t` (structural equality, not reference equality)
- Applying `t` to an empty store, then applying `copyTransforms(t)` to the same empty store, produces byte-identical resulting state

### Tracker-merge invariants

For any generated sequence of ops applied to a fresh `Tracker`:
- `tracker.transforms` after sequence == `copyTransforms(tracker.transforms)` after same sequence replayed into a fresh tracker
- Snapshotting a tracker, building a new tracker from the snapshot, and reading any block id returns the same result as reading from the original tracker (the ticket 5-chain scenario directly)
- `insert(B) then apply(B, field=val)` produces a transform set such that a fresh-tracker read of B shows the applied field

### Atomic-wrapper invariants

- Ops staged inside an `Atomic` wrapper and then committed match the result of applying them directly (no drops, no reordering that changes observable state).
- Ops staged inside `Atomic` and then rolled back leave the underlying tracker's transforms unchanged.

### Deletion-after-insert edge cases

- `insert(B) then delete(B)` collapses correctly (no zombie insert in snapshot).
- `apply(B, f=v) then delete(B)` in a tracker that already had B committed does the right thing per the contract (delete wins; apply is dropped).

## Expected outcomes

- Reproduces ticket 5-chain's hypothesis at the unit level on `main`, before that fix lands. If it does not, that tells us the bug is somewhere else and narrows the search.
- Catches future transform-merge regressions as a fast, deterministic CI signal (generated test cases can be seeded for repro).
- Documents the informal Transforms contract via executable properties.

## Out of scope

- Property tests for Collection / Log / Chain as units. Those layers *use* Transforms; test them via the Phase-1 harness in ticket 2-fresh-node-ddl-integration-harness. This ticket covers only the Transforms layer itself.
- Performance/fuzz at scale. Keep the property-test space bounded (small N, small value space) so CI stays under a few seconds.
